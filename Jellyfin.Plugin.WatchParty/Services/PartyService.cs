using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchParty.Services;

/// <summary>
/// Keeps every watch party in memory and keeps guests in step with the host.
/// </summary>
/// <remarks>
/// The host's player is the source of truth. Guests are moved with the server's remote-control
/// commands (play, pause, seek), so any client that can be remote controlled can follow along;
/// the web client also reports its own position for tighter sync and draws the theater.
/// </remarks>
public class PartyService : IDisposable
{
    public const int MaxChatLength = 140;

    public static readonly IReadOnlySet<string> Reactions = new HashSet<string>(StringComparer.Ordinal)
    {
        "clap", "laugh", "wow", "scared", "sad", "love", "cheer", "boo", "popcorn", "pause"
    };

    private static readonly TimeSpan InviteLifetime = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan HostStopGrace = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan PlayRetry = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan SeekCooldown = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan PauseCooldown = TimeSpan.FromSeconds(2.5);
    private static readonly TimeSpan GuestOfflineLimit = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan HostOfflineLimit = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan IdleLobbyLimit = TimeSpan.FromHours(2);
    private static readonly TimeSpan SeekLead = TimeSpan.FromSeconds(1);

    // Seats are filled from the middle of the row outwards, like people picking theater seats.
    private static readonly int[] SeatOrder = { 3, 4, 2, 5, 1, 6, 0, 7 };

    private readonly object _lock = new();
    private readonly List<Party> _parties = new();

    // Shown once to people whose party ended while they weren't looking.
    private readonly Dictionary<Guid, string> _endedNotes = new();
    private readonly ISessionManager _sessionManager;
    private readonly IUserManager _userManager;
    private readonly ILibraryManager _libraryManager;
    private readonly IImageProcessor _imageProcessor;
    private readonly AvatarStore _avatars;
    private readonly ILogger<PartyService> _logger;
    private Timer? _timer;
    private int _ticking;

    public PartyService(
        ISessionManager sessionManager,
        IUserManager userManager,
        ILibraryManager libraryManager,
        IImageProcessor imageProcessor,
        AvatarStore avatars,
        ILogger<PartyService> logger)
    {
        _sessionManager = sessionManager;
        _userManager = userManager;
        _libraryManager = libraryManager;
        _imageProcessor = imageProcessor;
        _avatars = avatars;
        _logger = logger;
    }

    private static int MaxMembers => Math.Clamp(Plugin.Instance?.Configuration.MaxMembers ?? 8, 2, 8);

    private static TimeSpan DriftTolerance => TimeSpan.FromSeconds(Math.Clamp(Plugin.Instance?.Configuration.DriftToleranceSeconds ?? 3, 1, 30));

    public void Start()
    {
        _sessionManager.PlaybackStart += OnPlaybackStart;
        _sessionManager.PlaybackProgress += OnPlayback;
        _sessionManager.PlaybackStopped += OnPlaybackStopped;
        _sessionManager.SessionEnded += OnSessionEnded;
        _timer = new Timer(_ => Tick(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    public void Stop()
    {
        _sessionManager.PlaybackStart -= OnPlaybackStart;
        _sessionManager.PlaybackProgress -= OnPlayback;
        _sessionManager.PlaybackStopped -= OnPlaybackStopped;
        _sessionManager.SessionEnded -= OnSessionEnded;
        _timer?.Dispose();
        _timer = null;
    }

    public void Dispose()
    {
        Stop();
        GC.SuppressFinalize(this);
    }

    // ---------- queries ----------

    public StateDto GetState(Guid me, string deviceId, long since)
    {
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            var party = PartyOf(me);
            PartyDto? dto = null;
            if (party is not null)
            {
                var member = party.Members.First(m => m.UserId == me);
                AdoptDeviceIfGone(member, deviceId);
                if (member.DeviceId == deviceId)
                {
                    member.LastPoll = now;
                }

                dto = ToDto(party, member, deviceId, since, now);
            }

            var invites = _parties
                .Where(p => p != party && p.Invites.TryGetValue(me, out var at) && now - at < InviteLifetime)
                .Select(p => ToInvite(p))
                .Where(i => i is not null)
                .Select(i => i!)
                .ToList();

            string? ended = null;
            if (party is null && _endedNotes.Remove(me, out var note))
            {
                ended = note;
            }

            return new StateDto(dto, invites, now, ended, ClientScript.Version);
        }
    }

    /// <summary>People the user can invite: everyone else who is allowed to watch the item.</summary>
    public IReadOnlyList<FriendDto> GetFriends(Guid me, Guid? itemId)
    {
        var item = itemId is { } id ? _libraryManager.GetItemById(id) : null;
        var online = _sessionManager.Sessions
            .Where(s => DateTime.UtcNow - s.LastActivityDate < TimeSpan.FromMinutes(10))
            .Select(s => s.UserId)
            .ToHashSet();

        lock (_lock)
        {
            var mine = PartyOf(me);
            return _userManager.GetUsers()
                .Where(u => u.Id != me && CanWatch(u, item))
                .OrderByDescending(u => online.Contains(u.Id))
                .ThenBy(u => u.Username, StringComparer.OrdinalIgnoreCase)
                .Select(u => new FriendDto(
                    u.Id,
                    u.Username,
                    _imageProcessor.GetImageCacheTag(u),
                    online.Contains(u.Id),
                    mine is not null && mine.Members.Any(m => m.UserId == u.Id),
                    mine is not null && mine.Invites.ContainsKey(u.Id)))
                .ToList();
        }
    }

    /// <summary>The user's players that a party can drive: this browser, a TV, a phone...</summary>
    public IReadOnlyList<DeviceDto> GetDevices(Guid me, string currentDeviceId)
    {
        var list = _sessionManager.Sessions
            .Where(s => s.UserId == me && s.SupportsRemoteControl && !string.IsNullOrEmpty(s.DeviceId)
                && (s.DeviceId == currentDeviceId || DateTime.UtcNow - s.LastActivityDate < TimeSpan.FromMinutes(10)))
            .GroupBy(s => s.DeviceId)
            .Select(g => g.OrderByDescending(s => s.LastActivityDate).First())
            .Select(s => new DeviceDto(s.DeviceId, s.DeviceName ?? "Unknown device", s.Client ?? string.Empty, s.DeviceId == currentDeviceId))
            .OrderByDescending(d => d.IsCurrent)
            .ThenBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return list;
    }

    // ---------- actions ----------

    public StateDto Create(Guid me, string callerDeviceId, Guid itemId, IEnumerable<Guid> invite, string? deviceId)
    {
        var user = _userManager.GetUserById(me) ?? throw new UnauthorizedAccessException();
        var item = _libraryManager.GetItemById(itemId);
        if (item is null || !IsPartyItem(item) || !CanWatch(user, item))
        {
            throw new ArgumentException("That can't be watched in a party.");
        }

        var device = ResolveDevice(me, callerDeviceId, deviceId);
        lock (_lock)
        {
            LeaveLocked(me, quiet: false);
            var now = DateTime.UtcNow;
            var party = new Party { HostId = me, ItemId = item.Id, Created = now, LastActivity = now, LobbySince = now };
            party.Members.Add(new Member { UserId = me, DeviceId = device, JoinedAt = now, Seat = SeatOrder[0] });
            _parties.Add(party);
            AddEvent(party, "system", me, user.Username + " started a watch party");
            _logger.LogInformation("{User} started a watch party for {Item}", user.Username, item.Name);
        }

        Invite(me, invite);
        return GetState(me, callerDeviceId, 0);
    }

    public void Invite(Guid me, IEnumerable<Guid> userIds)
    {
        var notify = new List<Guid>();
        string? hostName;
        string? itemName;
        lock (_lock)
        {
            var party = PartyOf(me) ?? throw new InvalidOperationException("You're not in a party.");
            var item = _libraryManager.GetItemById(party.ItemId);
            hostName = _userManager.GetUserById(me)?.Username;
            itemName = item?.Name;
            foreach (var id in userIds.Distinct())
            {
                var user = _userManager.GetUserById(id);
                if (user is null || id == me || party.Members.Any(m => m.UserId == id) || !CanWatch(user, item))
                {
                    continue;
                }

                if (!party.Invites.ContainsKey(id))
                {
                    notify.Add(id);
                }

                party.Invites[id] = DateTime.UtcNow;
            }
        }

        // Apps that can't run the party script still get a heads-up, so they know to open the web app.
        foreach (var id in notify)
        {
            foreach (var s in _sessionManager.Sessions.Where(s => s.UserId == id && s.SupportsRemoteControl && !IsWebClient(s)))
            {
                Fire(() => _sessionManager.SendMessageCommand(
                    null,
                    s.Id,
                    new MessageCommand
                    {
                        Header = "Watch party",
                        Text = $"{hostName} invited you to watch {itemName}. Open Jellyfin in a web browser to join.",
                        TimeoutMs = 15000
                    },
                    CancellationToken.None));
            }
        }
    }

    public StateDto Join(Guid me, string callerDeviceId, Guid partyId, string? deviceId)
    {
        var device = ResolveDevice(me, callerDeviceId, deviceId);
        lock (_lock)
        {
            var party = _parties.FirstOrDefault(p => p.Id == partyId) ?? throw new InvalidOperationException("That party has ended.");
            var already = party.Members.FirstOrDefault(m => m.UserId == me);
            if (already is not null)
            {
                if (already.DeviceId != device)
                {
                    already.LeaveVoice();
                }

                already.DeviceId = device;
                already.Away = false;
                already.ResetCommands();
            }
            else
            {
                if (!party.Invites.ContainsKey(me))
                {
                    throw new InvalidOperationException("You need an invite to join that party.");
                }

                if (party.Members.Count >= MaxMembers)
                {
                    throw new InvalidOperationException("That party is full.");
                }

                LeaveLocked(me, quiet: false);
                var taken = party.Members.Select(m => m.Seat).ToHashSet();
                var now = DateTime.UtcNow;
                party.Members.Add(new Member
                {
                    UserId = me,
                    DeviceId = device,
                    JoinedAt = now,
                    Seat = SeatOrder.First(s => !taken.Contains(s))
                });
                party.LastActivity = now;
                AddEvent(party, "join", me, Name(me) + " joined the party");
            }

            party.Invites.Remove(me);
        }

        Kick();
        return GetState(me, callerDeviceId, 0);
    }

    public void Decline(Guid me, Guid partyId)
    {
        lock (_lock)
        {
            _parties.FirstOrDefault(p => p.Id == partyId)?.Invites.Remove(me);
        }
    }

    public void Leave(Guid me)
    {
        lock (_lock)
        {
            LeaveLocked(me, quiet: false);
        }
    }

    public void End(Guid me)
    {
        lock (_lock)
        {
            var party = HostedBy(me);
            EndLocked(party, Name(me) + " ended the party", me);
        }
    }

    /// <summary>Host starts (or restarts after an intermission) the movie on everyone's screen.</summary>
    public void StartPlayback(Guid me, string callerDeviceId, bool fromBeginning)
    {
        Member host;
        Guid itemId;
        long position;
        lock (_lock)
        {
            var party = HostedBy(me);
            host = party.Members.First(m => m.UserId == me);
            AdoptDeviceIfGone(host, callerDeviceId);
            itemId = party.ItemId;
            position = fromBeginning ? 0 : party.LastPosition;
            foreach (var m in party.Members)
            {
                m.Away = false;
                m.ResetCommands();
            }
        }

        var session = FindSession(host) ?? throw new InvalidOperationException("Your player isn't connected. Open it, then try again.");
        Fire(() => _sessionManager.SendPlayCommand(
            null,
            session.Id,
            new PlayRequest { ItemIds = new[] { itemId }, StartPositionTicks = position, PlayCommand = PlayCommand.PlayNow, ControllingUserId = me },
            CancellationToken.None));
    }

    /// <summary>"Pass the remote": someone else takes over playback.</summary>
    public void MakeHost(Guid me, Guid newHost)
    {
        lock (_lock)
        {
            var party = HostedBy(me);
            if (party.Members.All(m => m.UserId != newHost))
            {
                throw new InvalidOperationException("They're not in the party.");
            }

            party.HostId = newHost;
            AddEvent(party, "system", newHost, Name(me) + " passed the remote to " + Name(newHost));
        }
    }

    public void Rejoin(Guid me, string callerDeviceId, string? deviceId)
    {
        var device = ResolveDevice(me, callerDeviceId, deviceId);
        lock (_lock)
        {
            var party = PartyOf(me) ?? throw new InvalidOperationException("You're not in a party.");
            var member = party.Members.First(m => m.UserId == me);
            if (member.DeviceId != device)
            {
                member.LeaveVoice();
            }

            member.DeviceId = device;
            if (member.Away)
            {
                member.Away = false;
                AddEvent(party, "join", me, Name(me) + " is back");
            }

            member.ResetCommands();
        }

        Kick();
    }

    public void React(Guid me, string reaction)
    {
        if (!Reactions.Contains(reaction))
        {
            throw new ArgumentException("Unknown reaction.");
        }

        lock (_lock)
        {
            var party = PartyOf(me) ?? throw new InvalidOperationException("You're not in a party.");
            var member = party.Members.First(m => m.UserId == me);
            var now = DateTime.UtcNow;
            if (now - member.LastReaction < TimeSpan.FromMilliseconds(400))
            {
                return;
            }

            member.LastReaction = now;
            AddEvent(party, "react", me, reaction);
        }
    }

    public void Chat(Guid me, string text)
    {
        text = (text ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return;
        }

        if (text.Length > MaxChatLength)
        {
            text = text[..MaxChatLength];
        }

        lock (_lock)
        {
            var party = PartyOf(me) ?? throw new InvalidOperationException("You're not in a party.");
            AddEvent(party, "chat", me, text);
        }
    }

    /// <summary>Joins or leaves voice chat, or mutes, from the browser that's in the party.</summary>
    public void Voice(Guid me, string deviceId, bool join, bool muted)
    {
        lock (_lock)
        {
            var party = PartyOf(me) ?? throw new InvalidOperationException("You're not in a party.");
            var member = party.Members.First(m => m.UserId == me);
            AdoptDeviceIfGone(member, deviceId);
            if (member.DeviceId != deviceId)
            {
                throw new InvalidOperationException("Voice chat works from the device you're watching on.");
            }

            if (join && !member.InVoice)
            {
                AddEvent(party, "voice", me, "🎙 " + Name(me) + " joined voice chat");
            }
            else if (!join && member.InVoice)
            {
                AddEvent(party, "voice", me, Name(me) + " left voice chat");
                foreach (var other in party.Members.Where(m => m.InVoice && m != member))
                {
                    other.Signals.Add(new SignalDto(me, "bye", string.Empty));
                }
            }

            if (!join)
            {
                member.LeaveVoice();
                return;
            }

            member.InVoice = true;
            member.Muted = muted;
        }
    }

    /// <summary>Passes a WebRTC message from one person's browser to another's in the same party.</summary>
    public void Signal(Guid me, string deviceId, Guid to, string kind, string data)
    {
        if (kind is not ("offer" or "answer" or "ice" or "bye"))
        {
            throw new ArgumentException("Unknown signal.");
        }

        if (data.Length > 20000)
        {
            throw new ArgumentException("Signal too large.");
        }

        lock (_lock)
        {
            var party = PartyOf(me) ?? throw new InvalidOperationException("You're not in a party.");
            var from = party.Members.First(m => m.UserId == me);
            var target = party.Members.FirstOrDefault(m => m.UserId == to);
            if (from.DeviceId != deviceId || !from.InVoice || target is null || !target.InVoice)
            {
                return;
            }

            if (target.Signals.Count < 300)
            {
                target.Signals.Add(new SignalDto(me, kind, data));
            }
        }
    }

    private static IReadOnlyList<IceServerDto> IceServers()
    {
        var raw = Plugin.Instance?.Configuration.IceServers ?? string.Empty;
        return raw.Split(new[] { ',', ' ', '\n', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(ParseIce)
            .Where(s => s is not null)
            .Select(s => s!)
            .ToList();
    }

    /// <summary>Reads stun:host:port, or turn:user:password@host:port.</summary>
    private static IceServerDto? ParseIce(string entry)
    {
        var colon = entry.IndexOf(':', StringComparison.Ordinal);
        if (colon < 0)
        {
            return null;
        }

        var scheme = entry[..colon];
        if (scheme is not ("stun" or "stuns" or "turn" or "turns"))
        {
            return null;
        }

        var rest = entry[(colon + 1)..];
        var at = rest.LastIndexOf('@');
        if (at < 0)
        {
            return new IceServerDto(entry, null, null);
        }

        var creds = rest[..at];
        var split = creds.IndexOf(':', StringComparison.Ordinal);
        return split < 0
            ? new IceServerDto(scheme + ":" + rest[(at + 1)..], creds, null)
            : new IceServerDto(scheme + ":" + rest[(at + 1)..], creds[..split], creds[(split + 1)..]);
    }

    /// <summary>The web client's own view of its player, which is fresher than the server's ~10 s progress reports.</summary>
    public void Report(Guid me, string deviceId, long positionTicks, bool isPaused)
    {
        lock (_lock)
        {
            var party = PartyOf(me);
            var member = party?.Members.FirstOrDefault(m => m.UserId == me && m.DeviceId == deviceId);
            // The browser only knows its video element; which item it is comes from the player's own reports.
            if (member?.Session is not { } session || member.DistrustWeb)
            {
                return;
            }

            member.LastPoll = DateTime.UtcNow;
            member.Web = new Snapshot(session.ItemId, Math.Max(0, positionTicks), isPaused, DateTime.UtcNow);
        }

        Kick();
    }

    // ---------- session events ----------

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e)
    {
        if (e.Session is { } session)
        {
            lock (_lock)
            {
                var (_, member) = MemberFor(session);
                if (member is not null)
                {
                    member.StartedAt = DateTime.UtcNow;
                }
            }
        }

        OnPlayback(sender, e);
    }

    private void OnPlayback(object? sender, PlaybackProgressEventArgs e)
    {
        var session = e.Session;
        if (session is null || e.Item is null)
        {
            return;
        }

        var now = DateTime.UtcNow;
        var paused = e.IsPaused;
        lock (_lock)
        {
            var (party, member) = MemberFor(session);
            if (party is null || member is null)
            {
                return;
            }

            var snap = new Snapshot(e.Item.Id, e.PlaybackPositionTicks ?? 0, paused, now);

            // If the browser's reports keep disagreeing with what the player tells the server
            // (some transcodes start the video element at an offset), stop trusting the browser.
            if (member.Web is { } web && !member.DistrustWeb && web.ItemId == snap.ItemId && now - web.At < TimeSpan.FromSeconds(3))
            {
                var gap = Math.Abs(web.Estimate(now) - snap.PositionTicks);
                member.WebStrikes = gap > TimeSpan.FromSeconds(20).Ticks ? member.WebStrikes + 1 : 0;
                if (member.WebStrikes >= 3)
                {
                    member.DistrustWeb = true;
                    member.Web = null;
                    _logger.LogInformation("Watch party: ignoring browser position reports from {Device}", session.DeviceName);
                }
            }

            member.Session = snap;
            member.StoppedAt = null;

            // A guest who starts watching something else on their own has stepped out.
            if (party.HostId != member.UserId && party.Status != PartyStatus.Lobby && !member.Away
                && snap.ItemId != party.ItemId && now - member.LastPlayCmd > TimeSpan.FromSeconds(10))
            {
                member.Away = true;
                member.Web = null;
                AddEvent(party, "leave", member.UserId, Name(member.UserId) + " stepped out");
            }
        }

        Kick();
    }

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        var session = e.Session;
        if (session is null)
        {
            return;
        }

        lock (_lock)
        {
            var (party, member) = MemberFor(session);
            if (party is null || member is null)
            {
                return;
            }

            var now = DateTime.UtcNow;
            member.Session = null;
            member.Web = null;
            member.StoppedAt = now;

            if (party.HostId != member.UserId && party.Status != PartyStatus.Lobby && !member.Away
                && e.Item?.Id == party.ItemId && now - member.LastPlayCmd > TimeSpan.FromSeconds(5))
            {
                member.Away = true;
                AddEvent(party, "leave", member.UserId, Name(member.UserId) + " stepped out");
            }
        }

        Kick();
    }

    private void OnSessionEnded(object? sender, SessionEventArgs e)
    {
        lock (_lock)
        {
            var (_, member) = MemberFor(e.SessionInfo);
            if (member is not null)
            {
                member.Session = null;
                member.Web = null;
            }
        }
    }

    // ---------- sync loop ----------

    private void Kick() => Task.Run(Tick);

    private void Tick()
    {
        if (Interlocked.Exchange(ref _ticking, 1) == 1)
        {
            return;
        }

        try
        {
            var commands = new List<Func<Task>>();
            lock (_lock)
            {
                var now = DateTime.UtcNow;
                foreach (var party in _parties.ToList())
                {
                    try
                    {
                        Sync(party, now, commands);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Watch party sync failed");
                    }
                }
            }

            foreach (var c in commands)
            {
                Fire(c);
            }
        }
        finally
        {
            Interlocked.Exchange(ref _ticking, 0);
        }
    }

    private void Sync(Party party, DateTime now, List<Func<Task>> commands)
    {
        party.Invites.Where(i => now - i.Value > InviteLifetime).Select(i => i.Key).ToList().ForEach(k => party.Invites.Remove(k));

        var host = party.Members.First(m => m.UserId == party.HostId);
        var hostSession = FindSession(host);

        // Tidy up people who closed their app.
        foreach (var m in party.Members.ToList())
        {
            if (FindSession(m) is not null)
            {
                m.OfflineSince = null;
                continue;
            }

            m.Session = null;
            m.Web = null;
            m.OfflineSince ??= now;
            if (m.InVoice && now - m.LastPoll > TimeSpan.FromSeconds(20))
            {
                m.LeaveVoice();
            }

            if (m != host && now - m.OfflineSince > GuestOfflineLimit)
            {
                party.Members.Remove(m);
                AddEvent(party, "leave", m.UserId, Name(m.UserId) + " left the party");
            }
        }

        if (hostSession is null && now - host.OfflineSince > HostOfflineLimit)
        {
            EndLocked(party, "The party ended because the host went offline");
            return;
        }

        if (party.Status == PartyStatus.Lobby && party.Members.Count == 1 && now - party.LastActivity > IdleLobbyLimit)
        {
            EndLocked(party, "The party ended");
            return;
        }

        var hs = host.Current(now);

        if (party.Status != PartyStatus.Lobby)
        {
            if (hs is null)
            {
                // The host stopped. Give their app a moment in case it's moving on to the next episode.
                party.HostStoppedAt ??= now;
                if (now - party.HostStoppedAt < HostStopGrace)
                {
                    return;
                }

                party.Status = PartyStatus.Lobby;
                party.LobbySince = now;
                party.HostStoppedAt = null;
                party.LastActivity = now;
                AddEvent(party, "system", host.UserId, "Intermission — " + Name(host.UserId) + " stopped the movie");
                foreach (var g in party.Members.Where(m => m != host && !m.Away && m.Current(now) is { } s && s.ItemId == party.ItemId))
                {
                    if (FindSession(g) is { } gs)
                    {
                        var id = gs.Id;
                        commands.Add(() => _sessionManager.SendPlaystateCommand(null, id, new PlaystateRequest { Command = PlaystateCommand.Stop }, CancellationToken.None));
                    }
                }

                return;
            }

            party.HostStoppedAt = null;
            if (hs.ItemId != party.ItemId)
            {
                var next = _libraryManager.GetItemById(hs.ItemId);
                if (next is null || !IsPartyItem(next))
                {
                    return;
                }

                party.ItemId = next.Id;
                AddEvent(party, "system", host.UserId, "Now playing " + DisplayName(next));
            }
        }
        else
        {
            // In the lobby, the party starts as soon as the host plays something.
            if (hs is null || host.StartedAt < party.LobbySince)
            {
                return;
            }

            var item = _libraryManager.GetItemById(hs.ItemId);
            if (item is null || !IsPartyItem(item))
            {
                return;
            }

            var changed = party.ItemId != item.Id;
            party.ItemId = item.Id;
            party.LastActivity = now;
            foreach (var m in party.Members)
            {
                m.Away = false;
                m.ResetCommands();
            }

            AddEvent(party, "system", host.UserId, (changed ? "Now playing " : "Lights down — ") + DisplayName(item));
        }

        party.Status = hs.IsPaused ? PartyStatus.Paused : PartyStatus.Playing;
        var hostPos = hs.Estimate(now);
        party.LastPosition = hostPos;

        foreach (var g in party.Members.Where(m => m != host && !m.Away))
        {
            var session = FindSession(g);
            if (session is null)
            {
                continue;
            }

            var sessionId = session.Id;
            var gs = g.Current(now);

            if (gs is null || gs.ItemId != party.ItemId)
            {
                if (now - g.LastPlayCmd < PlayRetry)
                {
                    continue;
                }

                if (g.PlayAttempts >= 2)
                {
                    g.Away = true;
                    AddEvent(party, "leave", g.UserId, Name(g.UserId) + "'s player didn't start — they can rejoin from the party menu");
                    continue;
                }

                g.PlayAttempts++;
                g.LastPlayCmd = now;
                var start = hostPos + (hs.IsPaused ? 0 : SeekLead.Ticks * 3);
                var request = new PlayRequest
                {
                    ItemIds = new[] { party.ItemId },
                    StartPositionTicks = start,
                    PlayCommand = PlayCommand.PlayNow,
                    ControllingUserId = party.HostId
                };
                commands.Add(() => _sessionManager.SendPlayCommand(null, sessionId, request, CancellationToken.None));
                continue;
            }

            g.PlayAttempts = 0;
            if (now - g.LastPlayCmd < TimeSpan.FromSeconds(4))
            {
                continue;
            }

            if (gs.IsPaused != hs.IsPaused && now - g.LastPauseCmd > PauseCooldown)
            {
                g.LastPauseCmd = now;
                var cmd = hs.IsPaused ? PlaystateCommand.Pause : PlaystateCommand.Unpause;
                commands.Add(() => _sessionManager.SendPlaystateCommand(null, sessionId, new PlaystateRequest { Command = cmd }, CancellationToken.None));
                if (!hs.IsPaused && now - g.LastRemoteHint > TimeSpan.FromSeconds(30))
                {
                    g.LastRemoteHint = now;
                    AddEvent(party, "hint", host.UserId, Name(host.UserId) + " has the remote. Use ✋ to ask for a pause.", g.UserId);
                }

                continue;
            }

            var drift = Math.Abs(gs.Estimate(now) - hostPos);
            var tolerance = hs.IsPaused ? TimeSpan.FromSeconds(1.5).Ticks : DriftTolerance.Ticks;
            if (drift > tolerance && now - g.LastSeekCmd > SeekCooldown && now - gs.At < TimeSpan.FromSeconds(15))
            {
                g.LastSeekCmd = now;
                var target = hostPos + (hs.IsPaused ? 0 : SeekLead.Ticks);

                // Assume the seek lands, so stale reports don't trigger another one straight away.
                g.Session = g.Session is null ? null : g.Session with { PositionTicks = target, At = now };
                g.Web = g.Web is null ? null : g.Web with { PositionTicks = target, At = now };
                commands.Add(() => _sessionManager.SendPlaystateCommand(
                    null,
                    sessionId,
                    new PlaystateRequest { Command = PlaystateCommand.Seek, SeekPositionTicks = target, ControllingUserId = party.HostId.ToString("N") },
                    CancellationToken.None));
            }
        }
    }

    // ---------- helpers ----------

    private Party? PartyOf(Guid userId) => _parties.FirstOrDefault(p => p.Members.Any(m => m.UserId == userId));

    private Party HostedBy(Guid userId)
    {
        var party = PartyOf(userId) ?? throw new InvalidOperationException("You're not in a party.");
        if (party.HostId != userId)
        {
            throw new InvalidOperationException("Only the host can do that.");
        }

        return party;
    }

    private (Party? Party, Member? Member) MemberFor(SessionInfo session)
    {
        foreach (var p in _parties)
        {
            var m = p.Members.FirstOrDefault(m => m.UserId == session.UserId && m.DeviceId == session.DeviceId);
            if (m is not null)
            {
                return (p, m);
            }
        }

        return (null, null);
    }

    private SessionInfo? FindSession(Member m) =>
        _sessionManager.Sessions
            .Where(s => s.UserId == m.UserId && s.DeviceId == m.DeviceId)
            .OrderByDescending(s => s.LastActivityDate)
            .FirstOrDefault();

    /// <summary>
    /// Someone who set the party up on one device (or closed that tab) and carries on from
    /// another takes the party with them, instead of it waiting on a player that's gone.
    /// </summary>
    private void AdoptDeviceIfGone(Member member, string callerDeviceId)
    {
        // A closed tab's session lingers for a while, but it loses its live connection straight away.
        if (member.DeviceId == callerDeviceId || FindSession(member) is { SupportsRemoteControl: true })
        {
            return;
        }

        if (_sessionManager.Sessions.Any(s => s.UserId == member.UserId && s.DeviceId == callerDeviceId))
        {
            member.DeviceId = callerDeviceId;
            member.LeaveVoice();
            member.Session = null;
            member.Web = null;
            member.DistrustWeb = false;
            member.ResetCommands();
        }
    }

    private string ResolveDevice(Guid me, string callerDeviceId, string? deviceId)
    {
        if (string.IsNullOrEmpty(deviceId) || deviceId == callerDeviceId)
        {
            return callerDeviceId;
        }

        var ok = _sessionManager.Sessions.Any(s => s.UserId == me && s.DeviceId == deviceId && s.SupportsRemoteControl);
        return ok ? deviceId : throw new InvalidOperationException("That device isn't available.");
    }

    private void LeaveLocked(Guid me, bool quiet)
    {
        var party = PartyOf(me);
        if (party is null)
        {
            return;
        }

        party.Members.RemoveAll(m => m.UserId == me);
        if (party.Members.Count == 0)
        {
            _parties.Remove(party);
            return;
        }

        if (!quiet)
        {
            AddEvent(party, "leave", me, Name(me) + " left the party");
        }

        if (party.HostId == me)
        {
            var next = party.Members.OrderBy(m => m.OfflineSince.HasValue).ThenBy(m => m.JoinedAt).First();
            party.HostId = next.UserId;
            AddEvent(party, "system", next.UserId, Name(next.UserId) + " is the host now");
        }
    }

    private void EndLocked(Party party, string message, Guid? endedBy = null)
    {
        _parties.Remove(party);
        _logger.LogInformation("Watch party ended: {Message}", message);
        foreach (var m in party.Members.Where(m => m.UserId != endedBy))
        {
            _endedNotes[m.UserId] = message;
        }
    }

    private static void AddEvent(Party party, string type, Guid userId, string? text, Guid? forUser = null)
    {
        party.Seq++;
        party.Events.Add(new PartyEvent(party.Seq, type, userId, text, DateTime.UtcNow, forUser));
        if (party.Events.Count > 100)
        {
            party.Events.RemoveRange(0, party.Events.Count - 100);
        }
    }

    private PartyDto ToDto(Party party, Member me, string callerDeviceId, long since, DateTime now)
    {
        var item = _libraryManager.GetItemById(party.ItemId);
        var backdrop = item is null ? null : BackdropSource(item);
        var members = party.Members
            .OrderBy(m => m.Seat)
            .Select(m =>
            {
                var user = _userManager.GetUserById(m.UserId);
                var session = FindSession(m);
                var current = m.Current(now);
                string status;
                if (session is null)
                {
                    status = "offline";
                }
                else if (party.Status == PartyStatus.Lobby)
                {
                    status = "lobby";
                }
                else if (m.Away)
                {
                    status = "away";
                }
                else
                {
                    status = current is not null && current.ItemId == party.ItemId ? "watching" : "joining";
                }

                return new MemberDto(
                    m.UserId,
                    user?.Username ?? "Someone",
                    user is null ? null : _imageProcessor.GetImageCacheTag(user),
                    m.UserId == party.HostId,
                    status,
                    m.Seat,
                    session?.DeviceName,
                    m.UserId == me.UserId,
                    _avatars.Get(m.UserId),
                    m.InVoice,
                    m.Muted);
            })
            .ToList();

        var events = party.Events
            .Where(e => e.Seq > since && (e.ForUserId is null || e.ForUserId == me.UserId))
            .Select(e => new EventDto(e.Seq, e.Type, e.UserId, e.Text, e.At))
            .ToList();

        // Voice signals are for the browser that's in the party, and are handed over once.
        IReadOnlyList<SignalDto> signals = Array.Empty<SignalDto>();
        if (me.DeviceId == callerDeviceId && me.Signals.Count > 0)
        {
            signals = me.Signals.ToList();
            me.Signals.Clear();
        }

        var invited = party.Invites.Keys
            .Select(id => _userManager.GetUserById(id))
            .Where(u => u is not null)
            .Select(u => new FriendDto(u!.Id, u.Username, _imageProcessor.GetImageCacheTag(u), false, false, true))
            .ToList();

        return new PartyDto(
            party.Id,
            party.ItemId,
            item?.Name ?? "Unknown",
            item is Episode ep ? EpisodeLabel(ep) : item?.ProductionYear?.ToString(System.Globalization.CultureInfo.InvariantCulture),
            item is null ? null : ImageTag(item, ImageType.Primary),
            backdrop is null ? null : ImageTag(backdrop, ImageType.Backdrop),
            backdrop?.Id,
            party.Status.ToString(),
            party.HostId == me.UserId,
            party.HostId,
            party.LastPosition,
            item?.RunTimeTicks,
            members,
            invited,
            events,
            party.Seq,
            MaxMembers,
            me.Away,
            me.DeviceId == callerDeviceId,
            FindSession(me)?.DeviceName,
            signals,
            IceServers());
    }

    private InviteDto? ToInvite(Party party)
    {
        var host = _userManager.GetUserById(party.HostId);
        var item = _libraryManager.GetItemById(party.ItemId);
        if (host is null || item is null)
        {
            return null;
        }

        return new InviteDto(
            party.Id,
            host.Id,
            host.Username,
            _imageProcessor.GetImageCacheTag(host),
            item.Id,
            DisplayName(item),
            ImageTag(item, ImageType.Primary),
            party.Members.Count,
            party.Status.ToString());
    }

    private string Name(Guid userId) => _userManager.GetUserById(userId)?.Username ?? "Someone";

    private static bool IsPartyItem(BaseItem item) => item is Video && !item.IsFolder;

    private static bool CanWatch(User user, BaseItem? item) =>
        !user.HasPermission(PermissionKind.IsDisabled)
        && user.HasPermission(PermissionKind.EnableMediaPlayback)
        && (item is null || item.IsVisible(user));

    private static bool IsWebClient(SessionInfo s) =>
        (s.Client ?? string.Empty).Contains("Web", StringComparison.OrdinalIgnoreCase);

    private static string EpisodeLabel(Episode ep)
    {
        var code = ep.ParentIndexNumber is { } s && ep.IndexNumber is { } e ? $"S{s}:E{e}" : null;
        return string.Join(" · ", new[] { ep.SeriesName, code }.Where(x => !string.IsNullOrEmpty(x)));
    }

    private static string DisplayName(BaseItem item) =>
        item is Episode ep ? $"{ep.SeriesName} — {ep.Name}" : item.Name;

    private string? ImageTag(BaseItem item, ImageType type)
    {
        var info = item.GetImageInfo(type, 0);
        return info is null ? null : _imageProcessor.GetImageCacheTag(item, info);
    }

    /// <summary>Episodes rarely have backdrops; borrow the show's.</summary>
    private static BaseItem BackdropSource(BaseItem item) =>
        item.GetImageInfo(ImageType.Backdrop, 0) is null && item is Episode { Series: { } series } ? series : item;

    private void Fire(Func<Task> action)
    {
        Task.Run(async () =>
        {
            try
            {
                await action().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Watch party command failed");
            }
        });
    }

    // ---------- state ----------

    private sealed class Party
    {
        public Guid Id { get; } = Guid.NewGuid();

        public Guid HostId { get; set; }

        public Guid ItemId { get; set; }

        public PartyStatus Status { get; set; } = PartyStatus.Lobby;

        public long LastPosition { get; set; }

        public DateTime Created { get; init; }

        public DateTime LastActivity { get; set; }

        public DateTime? HostStoppedAt { get; set; }

        /// <summary>Gets or sets when the party last went to the lobby; playback the host started after this starts the party.</summary>
        public DateTime LobbySince { get; set; }

        public List<Member> Members { get; } = new();

        public Dictionary<Guid, DateTime> Invites { get; } = new();

        public List<PartyEvent> Events { get; } = new();

        public long Seq { get; set; }
    }

    private sealed class Member
    {
        public Guid UserId { get; init; }

        public string DeviceId { get; set; } = string.Empty;

        public DateTime JoinedAt { get; init; }

        public int Seat { get; init; }

        public bool Away { get; set; }

        public DateTime LastPoll { get; set; }

        public DateTime? OfflineSince { get; set; }

        public DateTime? StoppedAt { get; set; }

        public DateTime StartedAt { get; set; }

        /// <summary>Gets or sets what the player last told the server.</summary>
        public Snapshot? Session { get; set; }

        /// <summary>Gets or sets what the web client last reported.</summary>
        public Snapshot? Web { get; set; }

        public bool DistrustWeb { get; set; }

        public int WebStrikes { get; set; }

        public DateTime LastPlayCmd { get; set; }

        public DateTime LastSeekCmd { get; set; }

        public DateTime LastPauseCmd { get; set; }

        public DateTime LastRemoteHint { get; set; }

        public DateTime LastReaction { get; set; }

        public int PlayAttempts { get; set; }

        public bool InVoice { get; set; }

        public bool Muted { get; set; }

        /// <summary>Gets voice signals waiting for this member's browser to pick up.</summary>
        public List<SignalDto> Signals { get; } = new();

        /// <summary>Drops out of voice, e.g. when the member moves to another device.</summary>
        public void LeaveVoice()
        {
            InVoice = false;
            Muted = false;
            Signals.Clear();
        }

        /// <summary>The freshest trustworthy view of this member's player, or null if nothing is playing.</summary>
        public Snapshot? Current(DateTime now)
        {
            var web = Web is { } w && now - w.At < TimeSpan.FromSeconds(6) ? w : null;
            var session = Session is { } s && now - s.At < TimeSpan.FromSeconds(60) ? s : null;
            if (web is null)
            {
                return session;
            }

            return session is null || web.At >= session.At ? web : session;
        }

        public void ResetCommands()
        {
            LastPlayCmd = DateTime.MinValue;
            LastSeekCmd = DateTime.MinValue;
            LastPauseCmd = DateTime.MinValue;
            PlayAttempts = 0;
        }
    }

    private sealed record Snapshot(Guid ItemId, long PositionTicks, bool IsPaused, DateTime At)
    {
        public long Estimate(DateTime now) => IsPaused ? PositionTicks : PositionTicks + (now - At).Ticks;
    }

    private sealed record PartyEvent(long Seq, string Type, Guid UserId, string? Text, DateTime At, Guid? ForUserId);
}
