using System;
using System.Collections.Generic;
using Jellyfin.Plugin.WatchParty.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.WatchParty;

/// <summary>
/// Watch movies together: a party plays in sync for everyone, with avatars in a virtual theater, reactions and chat.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Watch Party";

    public override Guid Id => Guid.Parse("f8632b44-5a33-421a-8021-0d66d6c2c7ef");

    public override string Description => "Watch movies and shows together in sync, with avatars in a virtual theater, reactions, chat and voice.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
        };
    }
}
