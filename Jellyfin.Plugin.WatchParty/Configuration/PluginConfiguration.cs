using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.WatchParty.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets how many people fit in a party, host included (the Xbox 360 theater had 8 seats).
    /// </summary>
    public int MaxMembers { get; set; } = 8;

    /// <summary>
    /// Gets or sets how far (in seconds) a guest may drift from the host before they are moved back in step.
    /// </summary>
    public double DriftToleranceSeconds { get; set; } = 3;

    /// <summary>
    /// Gets or sets the STUN/TURN servers browsers use to connect voice chat to each other, separated by commas.
    /// Add a TURN server (turn:user:password@host:port) if people behind strict NATs can't hear each other.
    /// </summary>
    public string IceServers { get; set; } = "stun:stun.l.google.com:19302";
}
