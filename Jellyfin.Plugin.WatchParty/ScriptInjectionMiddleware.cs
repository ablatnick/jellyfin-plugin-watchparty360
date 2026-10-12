using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.WatchParty;

/// <summary>
/// Adds the client script to the web client's index.html as it is served. Nothing on disk is
/// changed, so it works with read-only installs (most Docker images) and leaves no trace when
/// the plugin is removed.
/// </summary>
public class ScriptInjectionStartupFilter : IStartupFilter
{
    public const string ScriptTag = "<script src=\"../WatchParty/ClientScript\" defer></script>";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(InjectAsync);
        next(app);
    };

    private static bool IsIndex(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        var path = request.Path.Value ?? string.Empty;
        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task InjectAsync(HttpContext context, Func<Task> next)
    {
        if (!IsIndex(context.Request))
        {
            await next().ConfigureAwait(false);
            return;
        }

        // Ask for the plain, full page so it can be edited.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");

        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next().ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = original;
        }

        buffer.Position = 0;
        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && (context.Response.ContentType ?? string.Empty).Contains("text/html", StringComparison.OrdinalIgnoreCase);
        if (!isHtml)
        {
            await buffer.CopyToAsync(original).ConfigureAwait(false);
            return;
        }

        var html = Encoding.UTF8.GetString(buffer.ToArray());
        var at = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (at >= 0 && !html.Contains("WatchParty/ClientScript", StringComparison.Ordinal))
        {
            html = html.Insert(at, ScriptTag);
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentLength = bytes.Length;
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.CacheControl = "no-cache";
        await original.WriteAsync(bytes).ConfigureAwait(false);
    }
}
