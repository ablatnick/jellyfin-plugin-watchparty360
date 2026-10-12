using System;
using System.Collections.Generic;
using System.Net.Mime;
using System.Security.Claims;
using Jellyfin.Plugin.WatchParty.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.WatchParty.Api;

public class CreatePartyRequest
{
    public Guid ItemId { get; set; }

    public List<Guid> InviteUserIds { get; set; } = new();

    /// <summary>Gets or sets the device to play on; empty means the one making the request.</summary>
    public string? DeviceId { get; set; }
}

public class InviteRequest
{
    public List<Guid> UserIds { get; set; } = new();
}

public class JoinRequest
{
    public Guid PartyId { get; set; }

    public string? DeviceId { get; set; }
}

public class DeviceRequest
{
    public string? DeviceId { get; set; }
}

public class StartRequest
{
    public bool FromBeginning { get; set; }
}

public class HostRequest
{
    public Guid UserId { get; set; }
}

public class ReactRequest
{
    public string Reaction { get; set; } = string.Empty;
}

public class ChatRequest
{
    public string Text { get; set; } = string.Empty;
}

public class VoiceRequest
{
    public bool Join { get; set; }

    public bool Muted { get; set; }
}

public class SignalRequest
{
    public Guid To { get; set; }

    public string Kind { get; set; } = string.Empty;

    public string Data { get; set; } = string.Empty;
}

public class ReportRequest
{
    public long PositionTicks { get; set; }

    public bool IsPaused { get; set; }
}

[ApiController]
[Route("WatchParty")]
[Produces(MediaTypeNames.Application.Json)]
public class WatchPartyController : ControllerBase
{
    private readonly PartyService _parties;
    private readonly AvatarStore _avatars;

    public WatchPartyController(PartyService parties, AvatarStore avatars)
    {
        _parties = parties;
        _avatars = avatars;
    }

    /// <summary>The web client script.</summary>
    [HttpGet("ClientScript")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetClientScript()
    {
        Response.Headers.CacheControl = "no-cache";
        return File(ClientScript.Bytes, "application/javascript");
    }

    /// <summary>The current user's party (with events after <paramref name="since"/>) and pending invites.</summary>
    [HttpGet("State")]
    [Authorize]
    public ActionResult<StateDto> GetState([FromQuery] long since = 0)
        => Ok(_parties.GetState(UserId(), DeviceId(), since));

    /// <summary>People the current user can invite, optionally limited to those allowed to watch an item.</summary>
    [HttpGet("Friends")]
    [Authorize]
    public ActionResult<IReadOnlyList<FriendDto>> GetFriends([FromQuery] Guid? itemId)
        => Ok(_parties.GetFriends(UserId(), itemId));

    /// <summary>The current user's players that a party can drive.</summary>
    [HttpGet("Devices")]
    [Authorize]
    public ActionResult<IReadOnlyList<DeviceDto>> GetDevices()
        => Ok(_parties.GetDevices(UserId(), DeviceId()));

    [HttpPost("Party")]
    [Authorize]
    public ActionResult<StateDto> Create([FromBody] CreatePartyRequest request)
        => Run(() => _parties.Create(UserId(), DeviceId(), request.ItemId, request.InviteUserIds, request.DeviceId));

    [HttpPost("Invite")]
    [Authorize]
    public ActionResult Invite([FromBody] InviteRequest request)
        => Run(() => _parties.Invite(UserId(), request.UserIds));

    [HttpPost("Join")]
    [Authorize]
    public ActionResult<StateDto> Join([FromBody] JoinRequest request)
        => Run(() => _parties.Join(UserId(), DeviceId(), request.PartyId, request.DeviceId));

    [HttpPost("Decline")]
    [Authorize]
    public ActionResult Decline([FromBody] JoinRequest request)
        => Run(() => _parties.Decline(UserId(), request.PartyId));

    [HttpPost("Leave")]
    [Authorize]
    public ActionResult Leave()
        => Run(() => _parties.Leave(UserId()));

    [HttpPost("End")]
    [Authorize]
    public ActionResult End()
        => Run(() => _parties.End(UserId()));

    [HttpPost("Start")]
    [Authorize]
    public ActionResult Start([FromBody] StartRequest request)
        => Run(() => _parties.StartPlayback(UserId(), DeviceId(), request.FromBeginning));

    [HttpPost("Host")]
    [Authorize]
    public ActionResult MakeHost([FromBody] HostRequest request)
        => Run(() => _parties.MakeHost(UserId(), request.UserId));

    [HttpPost("Rejoin")]
    [Authorize]
    public ActionResult Rejoin([FromBody] DeviceRequest request)
        => Run(() => _parties.Rejoin(UserId(), DeviceId(), request.DeviceId));

    [HttpPost("React")]
    [Authorize]
    public ActionResult React([FromBody] ReactRequest request)
        => Run(() => _parties.React(UserId(), request.Reaction));

    [HttpPost("Chat")]
    [Authorize]
    public ActionResult Chat([FromBody] ChatRequest request)
        => Run(() => _parties.Chat(UserId(), request.Text));

    /// <summary>The web player's position, for tighter sync than the server's progress reports.</summary>
    [HttpPost("Report")]
    [Authorize]
    public ActionResult Report([FromBody] ReportRequest request)
        => Run(() => _parties.Report(UserId(), DeviceId(), request.PositionTicks, request.IsPaused));

    /// <summary>Joins, leaves or mutes voice chat.</summary>
    [HttpPost("Voice")]
    [Authorize]
    public ActionResult Voice([FromBody] VoiceRequest request)
        => Run(() => _parties.Voice(UserId(), DeviceId(), request.Join, request.Muted));

    /// <summary>Passes a WebRTC message to another person in the party.</summary>
    [HttpPost("Signal")]
    [Authorize]
    public ActionResult Signal([FromBody] SignalRequest request)
        => Run(() => _parties.Signal(UserId(), DeviceId(), request.To, request.Kind, request.Data));

    /// <summary>The current user's avatar, or 204 if they haven't made one yet.</summary>
    [HttpGet("Avatar")]
    [Authorize]
    public ActionResult<AvatarDto> GetAvatar()
        => _avatars.Get(UserId()) is { } a ? Ok(a) : NoContent();

    [HttpPost("Avatar")]
    [Authorize]
    public ActionResult<AvatarDto> SetAvatar([FromBody] AvatarDto avatar)
        => Run(() => _avatars.Set(UserId(), avatar));

    private ActionResult Run(Action action)
    {
        try
        {
            action();
            return NoContent();
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return BadRequest(ex.Message);
        }
    }

    private ActionResult<T> Run<T>(Func<T> action)
    {
        try
        {
            return Ok(action());
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return BadRequest(ex.Message);
        }
    }

    private Guid UserId()
    {
        var value = User.FindFirstValue("Jellyfin-UserId");
        return Guid.TryParse(value, out var id) ? id : throw new UnauthorizedAccessException();
    }

    private string DeviceId() => User.FindFirstValue("Jellyfin-DeviceId") ?? throw new UnauthorizedAccessException();
}
