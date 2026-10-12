using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WatchParty.Services;

/// <summary>How someone's person in the theater looks.</summary>
public record AvatarDto(
    string Skin,
    string HairStyle,
    string HairColor,
    string Top,
    string TopColor,
    string Accessory,
    bool UsePhoto);

/// <summary>
/// Keeps everyone's avatar in <c>&lt;data&gt;/watchparty/avatars.json</c>.
/// </summary>
public partial class AvatarStore
{
    public static readonly IReadOnlySet<string> HairStyles = new HashSet<string>(StringComparer.Ordinal)
    {
        "short", "long", "curly", "bun", "ponytail", "mohawk", "spiky", "bald"
    };

    public static readonly IReadOnlySet<string> Tops = new HashSet<string>(StringComparer.Ordinal)
    {
        "tee", "stripes", "hoodie", "jersey", "suit"
    };

    public static readonly IReadOnlySet<string> Accessories = new HashSet<string>(StringComparer.Ordinal)
    {
        "none", "glasses", "shades", "headphones", "cap", "beanie", "partyhat", "crown", "catears"
    };

    private readonly object _lock = new();
    private readonly string _path;
    private readonly ILogger<AvatarStore> _logger;
    private Dictionary<Guid, AvatarDto>? _avatars;

    public AvatarStore(IApplicationPaths paths, ILogger<AvatarStore> logger)
    {
        _path = Path.Combine(paths.DataPath, "watchparty", "avatars.json");
        _logger = logger;
    }

    public AvatarDto? Get(Guid userId)
    {
        lock (_lock)
        {
            return Load().TryGetValue(userId, out var a) ? a : null;
        }
    }

    public AvatarDto Set(Guid userId, AvatarDto avatar)
    {
        var clean = Validate(avatar);
        lock (_lock)
        {
            var all = Load();
            all[userId] = clean;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                var tmp = _path + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(all));
                File.Move(tmp, _path, true);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not save avatars to {Path}", _path);
            }
        }

        return clean;
    }

    private static AvatarDto Validate(AvatarDto a)
    {
        static string Color(string? c, string name) =>
            c is not null && ColorPattern().IsMatch(c) ? c.ToLowerInvariant() : throw new ArgumentException($"Pick a {name} from the list.");
        static string OneOf(string? v, IReadOnlySet<string> allowed, string name) =>
            v is not null && allowed.Contains(v) ? v : throw new ArgumentException($"Unknown {name}.");

        return new AvatarDto(
            Color(a.Skin, "skin tone"),
            OneOf(a.HairStyle, HairStyles, "hairstyle"),
            Color(a.HairColor, "hair color"),
            OneOf(a.Top, Tops, "top"),
            Color(a.TopColor, "top color"),
            OneOf(a.Accessory, Accessories, "accessory"),
            a.UsePhoto);
    }

    private Dictionary<Guid, AvatarDto> Load()
    {
        if (_avatars is not null)
        {
            return _avatars;
        }

        try
        {
            _avatars = File.Exists(_path)
                ? JsonSerializer.Deserialize<Dictionary<Guid, AvatarDto>>(File.ReadAllText(_path)) ?? new()
                : new();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not read avatars from {Path}; starting fresh", _path);
            _avatars = new();
        }

        return _avatars;
    }

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();
}
