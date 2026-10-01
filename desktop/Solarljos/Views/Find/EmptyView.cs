using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Find;

/// <summary>
/// Why a search by name found nothing, what to try next, and where else a copy may be (emptyView
/// in app.js): only what limited the search itself is named, since the results' own filters
/// hide, and never make a search come back empty.
/// </summary>
public static class EmptyView
{
    static Tr T => Tr.Instance;

    static string Str(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    /// <summary>The words of its heading.</summary>
    public static string Title(FindRequest r) =>
        r.Name.Length > 0 ? T.Get("empty.name.title", ("name", r.Name))
        : r.Containing.Length > 0 ? T.Get("empty.containing.title", ("text", r.Containing))
        : T.Get("empty.type.title", ("type", ProgressView.TypeWords(r.Types)));

    /// <param name="again">Searches again with what is given, from elsewhere than the form.</param>
    /// <param name="toForm">Goes to the form, with the focus in the box it names ("containing"), or as it is (null).</param>
    /// <param name="back">Goes back to the form.</param>
    public static FrameworkElement Make(Session session, Job job, Action<FindRequest> again, Action<string?> toForm, Action back, out TextBlock heading)
    {
        var r = FindRequest.Of(job);
        var per = job.Said("perSource") is { ValueKind: JsonValueKind.Array } p ? p.EnumerateArray().ToList() : [];
        var failed = per.Where((s) => Str(s, "error").Length > 0).ToList();
        int allPlaces = session.Sources.Count;

        bool limited = r.Sources is { Count: > 0 } src && src.Count < allPlaces;
        var filters = new List<string>();
        if (limited) filters.Add(T.Get("empty.filter.sources", ("count", r.Sources!.Count)));
        if (r.Types.Count > 0 && (r.Name.Length > 0 || r.Containing.Length > 0)) filters.Add(T["empty.filter.type"]);
        if (!session.Discover) filters.Add(T["empty.filter.onlyAdded"]);

        var why = new List<string> { T.Get("empty.why.nowhere", ("count", per.Count > 0 ? per.Count : allPlaces)) };
        if (failed.Count > 0)
            why.Add(T.Get("empty.why.failed", ("count", failed.Count), ("names", Formats.List(failed.Select((s) => Formats.SourceLabel(Str(s, "id"), Str(s, "label")))))));
        if (filters.Count > 0) why.Add(T.Get("empty.why.filters", ("filters", Formats.List(filters))));
        why.Add(T["empty.why.old"]);
        why.Add(T["empty.why.neverOpened"]);

        var tries = new List<Button>();
        if (Arrangement.PartOfName(r.Name) is { } part)
            tries.Add(Build.Button(T.Get("empty.try.shorter", ("part", part)), () => again(r with { Name = part }), "BtnPrimary"));
        if (r.Containing.Length == 0) tries.Add(Build.Button(T["empty.try.containing"], () => toForm("containing")));
        if (filters.Count > 0)
        {
            var wider = r with { Sources = null, Types = r.Name.Length > 0 || r.Containing.Length > 0 ? [] : r.Types };
            tries.Add(Build.Button(T["empty.try.noFilters"], () =>
            {
                session.Discover = true;
                again(wider);
            }));
        }
        tries.Add(Build.Button(T["empty.try.where"], () => MainWindow.Navigate("folder")));
        tries.Add(Build.Button(T["empty.try.otherDisk"], () => MainWindow.Navigate("sources")));

        var elsewhere = new[] { T["empty.else.cloud"], T["empty.else.email"], T["empty.else.copies"], T["empty.else.app"] };

        var body = new List<UIElement?>
        {
            Part(T["empty.why"], Bullets(why)),
            Part(T["empty.try"], StatePage.Actions(tries.ToArray())),
            Part(T["empty.elsewhere"], Bullets(elsewhere)),
        };
        if (per.Count > 0)
        {
            var lines = new List<UIElement>();
            foreach (var s in per)
            {
                var tb = Build.Text("", "Body");
                tb.Margin = new Thickness(0, 4, 0, 0);
                tb.Inlines.Add(new Run("• "));
                tb.Inlines.Add(new Run(Formats.SourceLabel(Str(s, "id"), Str(s, "label"))) { FontWeight = FontWeights.Bold });
                bool skipped = s.TryGetProperty("skipped", out var sk) && sk.ValueKind == JsonValueKind.True;
                long count = s.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number ? (long)c.GetDouble() : 0;
                var error = Str(s, "error");
                tb.Inlines.Add(new Run(": " + (error.Length > 0 ? T["progress.failed"] : skipped ? T["progress.skipped"] : T.Get("progress.found", ("count", count)))));
                if (error.Length > 0)
                {
                    var why2 = new Run($" ({error})");
                    why2.SetResourceReference(TextElement.ForegroundProperty, "Text2");
                    tb.Inlines.Add(why2);
                }
                lines.Add(tb);
                if (s.TryGetProperty("notes", out var notes) && notes.ValueKind == JsonValueKind.Array)
                    foreach (var n in notes.EnumerateArray()) lines.Add(Build.Text("◦ " + n, "Body").Margin(20, 2, 0, 0));
            }
            body.Add(Build.More(T["empty.details"], false, false, lines.ToArray()).Margin(0, 16, 0, 0));
        }
        bool said = per.Any((s) => Str(s, "error").Length > 0 || (s.TryGetProperty("notes", out var n) && n.ValueKind == JsonValueKind.Array && n.GetArrayLength() > 0));
        body.Add(StatePage.OldLanguage(job, said));
        var backRow = StatePage.Actions(Build.Button(T["common.back"], back));
        backRow.Margin = new Thickness(0, 24, 0, 0);
        body.Add(backRow);
        var page = StatePage.Make("empty", Title(r), body.ToArray());
        heading = FindHeading(page) ?? Build.Heading(Title(r));
        var holder = new Border { Child = page, MaxWidth = 880, HorizontalAlignment = HorizontalAlignment.Stretch };
        return Build.Page(holder);
    }

    /// <summary>The heading StatePage made, for the focus to start on.</summary>
    static TextBlock? FindHeading(FrameworkElement page) =>
        page is DockPanel d ? d.Children.OfType<StackPanel>().FirstOrDefault()?.Children.OfType<TextBlock>().FirstOrDefault() : null;

    /// <summary>A part of the page: a card with its heading and what it says (the page's .panel.empty-part).</summary>
    static Border Part(string title, UIElement body)
    {
        var h = Build.Heading(title, 2);
        h.FontSize = 17;
        h.Margin = new Thickness(0, 0, 0, 8);
        var card = Build.Card(Build.Stack(h, body), 24);
        card.Margin = new Thickness(0, 16, 0, 0);
        return card;
    }

    static StackPanel Bullets(IEnumerable<string> lines)
    {
        var s = new StackPanel();
        foreach (var line in lines)
        {
            var dot = Build.Text("•", "Body");
            dot.Margin = new Thickness(0, 0, 10, 0);
            var text = Build.Text(line, "Body");
            var row = new DockPanel { Margin = new Thickness(4, 4, 0, 4) };
            DockPanel.SetDock(dot, Dock.Left);
            row.Children.Add(dot);
            row.Children.Add(text);
            s.Children.Add(row);
        }
        return s;
    }
}
