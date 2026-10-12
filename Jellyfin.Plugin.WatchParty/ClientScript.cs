using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.WatchParty;

/// <summary>
/// The web client script, stamped with a version so open browser tabs can tell when the plugin was updated.
/// </summary>
public static class ClientScript
{
    private static readonly Lazy<(byte[] Bytes, string Version)> Script = new(Load);

    public static byte[] Bytes => Script.Value.Bytes;

    public static string Version => Script.Value.Version;

    private static (byte[] Bytes, string Version) Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Jellyfin.Plugin.WatchParty.Web.watchparty.js")
            ?? throw new InvalidOperationException("The Watch Party client script is missing from the plugin.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var text = reader.ReadToEnd();
        var version = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..12].ToLowerInvariant();
        return (Encoding.UTF8.GetBytes(text.Replace("__WP_VERSION__", version, StringComparison.Ordinal)), version);
    }
}
