using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.WatchParty.Services;

public enum PartyStatus
{
    /// <summary>Waiting for the host to start (or restart) the movie.</summary>
    Lobby,
    Playing,
    Paused
}

public record StateDto(PartyDto? Party, IReadOnlyList<InviteDto> Invites, DateTime ServerTime, string? EndedNote, string Version);

public record PartyDto(
    Guid Id,
    Guid ItemId,
    string ItemName,
    string? ItemSubtitle,
    string? ImageTag,
    string? BackdropTag,
    Guid? BackdropItemId,
    string Status,
    bool IsHost,
    Guid HostId,
    long PositionTicks,
    long? RunTimeTicks,
    IReadOnlyList<MemberDto> Members,
    IReadOnlyList<FriendDto> Invited,
    IReadOnlyList<EventDto> Events,
    long Seq,
    int MaxMembers,
    bool IsAway,
    bool OnThisDevice,
    string? DeviceName,
    IReadOnlyList<SignalDto> Signals,
    IReadOnlyList<IceServerDto> IceServers);

public record MemberDto(Guid UserId, string Name, string? ImageTag, bool IsHost, string Status, int Seat, string? DeviceName, bool IsMe, AvatarDto? Avatar, bool InVoice, bool Muted);

public record EventDto(long Seq, string Type, Guid UserId, string? Text, DateTime At);

public record InviteDto(Guid PartyId, Guid HostId, string HostName, string? HostImageTag, Guid ItemId, string ItemName, string? ImageTag, int Watching, string Status);

public record FriendDto(Guid Id, string Name, string? ImageTag, bool Online, bool InParty, bool Invited);

/// <summary>A WebRTC message (offer, answer, ICE candidate or hang-up) passed between two people's browsers.</summary>
public record SignalDto(Guid From, string Kind, string Data);

public record IceServerDto(string Urls, string? Username, string? Credential);

public record DeviceDto(string DeviceId, string Name, string Client, bool IsCurrent);
