using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WatchParty.Services;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.WatchParty;

/// <summary>
/// Runs the party sync loop while the server is up.
/// </summary>
public class StartupService : IHostedService
{
    private readonly PartyService _parties;

    public StartupService(PartyService parties)
    {
        _parties = parties;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _parties.Start();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _parties.Stop();
        return Task.CompletedTask;
    }
}
