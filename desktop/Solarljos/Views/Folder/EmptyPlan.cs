using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Folder;

/// <summary>
/// Why nothing was found inside a folder, what to try next, and where else a copy may be (emptyView
/// in src/gui/ui/app.js, for a folder): what limited the plan -- only what is missing now, a day,
/// some places, only the places added -- with a way to plan again without it.
/// </summary>
static class EmptyPlan
{
    static Tr T => Tr.Instance;

    static string Str(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    public static Part Make(FolderView owner, Job job, FolderRequest r)
    {
        var session = App.Session;
        var per = job.Said("perSource") is { ValueKind: JsonValueKind.Array } p ? p.EnumerateArray().ToList() : [];
        var failed = per.Where((s) => Str(s, "error").Length > 0).ToList();
        var folder = job.Said("folder") is { ValueKind: JsonValueKind.String } f ? f.GetString() ?? r.Folder : r.Folder;
        var title = T.Get("empty.folder.title", ("folder", folder));

        // Only what limited the plan itself.
        int all = session?.Sources.Count ?? 0;
        bool limited = r.Sources is { Count: > 0 } src && src.Count < all;
        var filters = new List<string>();
        if (r.DeletedOnly) filters.Add(T["empty.filter.deletedOnly"]);
        if (r.Since is not null) filters.Add(T["empty.filter.dates"]);
        if (limited) filters.Add(T.Get("empty.filter.sources", ("count", r.Sources!.Count)));
        if (session is { Discover: false }) filters.Add(T["empty.filter.onlyAdded"]);

        var why = new List<string> { T.Get("empty.why.nowhere", ("count", per.Count > 0 ? per.Count : all)) };
        if (failed.Count > 0)
        {
            why.Add(T.Get("empty.why.failed", ("count", failed.Count),
                ("names", Formats.List(failed.Select((s) => Formats.SourceLabel(Str(s, "id"), Str(s, "label")))))));
        }
        if (filters.Count > 0) why.Add(T.Get("empty.why.filters", ("filters", Formats.List(filters))));
        why.Add(T["empty.why.old"]);
        why.Add(T["empty.why.neverOpened"]);

        var tries = new List<Button>();
        if (filters.Count > 0)
        {
            var wider = r with { Sources = null, DeletedOnly = false, Since = null, SinceDate = "" };
            tries.Add(Build.Button(T["empty.try.noFilters"], () =>
            {
                if (App.Session is { } s) s.Discover = true;
                owner.Again(wider);
            }));
        }
        tries.Add(Build.Button(T["empty.try.otherDisk"], () => MainWindow.Navigate("sources")));

        var elsewhere = new[] { T["empty.else.cloud"], T["empty.else.email"], T["empty.else.copies"], T["empty.else.app"] };

        UIElement? details = null;
        if (per.Count > 0)
        {
            var lines = new List<UIElement>();
            foreach (var s in per)
            {
                var name = Formats.SourceLabel(Str(s, "id"), Str(s, "label"));
                var error = Str(s, "error");
                bool skipped = s.TryGetProperty("skipped", out var sk) && sk.ValueKind == JsonValueKind.True;
                long count = s.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt64() : 0;
                var said = error.Length > 0 ? T["progress.failed"] : skipped ? T["progress.skipped"] : T.Get("progress.found", ("count", count));
                var line = Build.Text("", "Body");
                line.Margin = new Thickness(0, 4, 0, 0);
                line.Inlines.Add(new System.Windows.Documents.Run("• "));
                line.Inlines.Add(new System.Windows.Documents.Run(name) { FontWeight = FontWeights.Bold });
                line.Inlines.Add(new System.Windows.Documents.Run(": " + said));
                if (error.Length > 0)
                {
                    var why2 = new System.Windows.Documents.Run($" ({error})");
                    why2.SetResourceReference(System.Windows.Documents.TextElement.ForegroundProperty, "Text2");
                    line.Inlines.Add(why2);
                }
                lines.Add(line);
                if (s.TryGetProperty("notes", out var notes) && notes.ValueKind == JsonValueKind.Array)
                    foreach (var n in notes.EnumerateArray()) lines.Add(Bits.Bullet(n.ToString()).Margin(24, 2, 0, 0));
            }
            var more = Build.More(T["empty.details"], false, true, lines.ToArray());
            more.Margin = new Thickness(0, 16, 0, 0);
            details = more;
        }

        Border part(string key, params UIElement?[] body)
        {
            var b = Bits.Panel(T[key], body);
            b.Margin = new Thickness(0, 16, 0, 0);
            return b;
        }
        var back = Build.Button(T["common.back"], () => owner.Go("", focus: true));
        var page = StatePage.Make("empty", title,
            part("empty.why", why.Select((t) => (UIElement)Bits.Bullet(t)).ToArray()),
            part("empty.try", Build.Text(T["empty.try.spelling"], "Body"), StatePage.Actions(tries.ToArray())),
            part("empty.elsewhere", elsewhere.Select((t) => (UIElement)Bits.Bullet(t)).ToArray()),
            details,
            StatePage.OldLanguage(job, per.Any((s) => Str(s, "error").Length > 0 || (s.TryGetProperty("notes", out var n) && n.ValueKind == JsonValueKind.Array && n.GetArrayLength() > 0))),
            StatePage.Actions(back).Margin(0, 16, 0, 0));
        return new Part(Build.Page(page, 880), title, job);
    }
}
