using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Media;

/// <summary>
/// Why a search for photos and videos found nothing, what to try next, and where else a copy may
/// be (emptyView in src/gui/ui/app.js, as it reads for photos): what limited the search itself --
/// the filters of the grid only hide, they never make a search come back empty -- and what each
/// place searched had to say.
/// </summary>
public static class EmptyMedia
{
    static Tr T => Tr.Instance;

    public static FrameworkElement Make(MediaView owner, Session session, Job job)
    {
        var r = MediaRequest.Of(job);
        var per = job.Said("perSource") is { ValueKind: JsonValueKind.Array } p ? p.EnumerateArray().ToList() : [];
        string S(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        bool B(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
        long N(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? (long)v.GetDouble() : 0;
        bool Notes(JsonElement o) => o.TryGetProperty("notes", out var n) && n.ValueKind == JsonValueKind.Array && n.GetArrayLength() > 0;
        var failed = per.Where((s) => S(s, "error").Length > 0).ToList();

        var filters = new List<string>();
        if (r.Sources is { Count: > 0 } src && src.Count < session.Sources.Count) filters.Add(T.Get("empty.filter.sources", ("count", src.Count)));
        if (!session.Discover) filters.Add(T["empty.filter.onlyAdded"]);

        var why = new List<string> { T.Get("empty.why.nowhere", ("count", per.Count > 0 ? per.Count : session.Sources.Count)) };
        if (failed.Count > 0)
            why.Add(T.Get("empty.why.failed", ("count", failed.Count), ("names", Formats.List(failed.Select((s) => Formats.SourceLabel(S(s, "id"), S(s, "label")))))));
        if (filters.Count > 0) why.Add(T.Get("empty.why.filters", ("filters", Formats.List(filters))));
        why.Add(T["empty.why.ssd"]);
        why.Add(T["empty.why.video"]);

        var tries = new List<Button?>();
        if (filters.Count > 0)
        {
            tries.Add(Build.Button(T["empty.try.noFilters"], async () =>
            {
                var wider = r.Clone();
                wider.Sources = null;
                session.Discover = true;
                await owner.AgainAsync(wider);
            }));
        }
        tries.Add(Build.Button(T["empty.try.otherDisk"], () => MainWindow.Navigate("sources")));

        var elsewhere = new[] { "empty.else.cloud", "empty.else.phone", "empty.else.chat", "empty.else.email", "empty.else.copies" }.Select((k) => T[k]);

        var body = new List<UIElement?>
        {
            Part("empty.why", Build.Bullets(why)),
            Part("empty.try", Build.Text(T["empty.try.card"]).Margin(0, 0, 0, 4), StatePage.Actions(tries.ToArray())),
            Part("empty.elsewhere", Build.Bullets(elsewhere)),
        };
        if (per.Count > 0)
        {
            var lines = new List<Build.Bulleted>();
            foreach (var s in per)
            {
                var result = S(s, "error").Length > 0 ? T["progress.failed"] : B(s, "skipped") ? T["progress.skipped"] : T.Get("progress.found", ("count", N(s, "count")));
                var notes = s.TryGetProperty("notes", out var ns) && ns.ValueKind == JsonValueKind.Array ? ns.EnumerateArray().Select((n) => n.ToString()).ToList() : null;
                lines.Add(Build.NamedLine(Formats.SourceLabel(S(s, "id"), S(s, "label")), result, S(s, "error"), notes));
            }
            var details = Build.More(T["empty.details"], false, false, Build.Bullets(lines));
            details.Margin = new Thickness(0, 16, 0, 0);
            body.Add(details);
        }
        body.Add(StatePage.OldLanguage(job, per.Any((s) => S(s, "error").Length > 0 || Notes(s))));
        var back = StatePage.Actions(Build.Button(T["common.back"], () => owner.ShowForm(false)));
        back.Margin = new Thickness(0, 24, 0, 0);
        body.Add(back);

        var page = StatePage.Make("empty", T["empty.media.title"], body.ToArray());
        return Build.Page(page, 880);
    }

    /// <summary>A part of the page in a card of its own, with its heading: a group named by it, as the page's section labelled by its h2.</summary>
    static Labeled Part(string key, params UIElement?[] body)
    {
        var s = Build.Stack(Build.Heading(T[key], 2).Margin(0, 0, 0, 8));
        ((TextBlock)s.Children[0]).FontSize = 17;
        foreach (var b in body) if (b is not null) s.Children.Add(b);
        var part = Labeled.Group(T[key], Build.Card(s));
        part.Margin = new Thickness(0, 16, 0, 0);
        return part;
    }
}
