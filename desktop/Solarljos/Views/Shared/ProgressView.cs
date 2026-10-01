using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Shared;

/// <summary>
/// How a search goes, one row per place, from the event stream: waiting, how far, what it found
/// (progressView in app.js). Its heading says what is searched for; Stop ends it.
/// </summary>
public sealed class ProgressView : UserControl
{
    static Tr T => Tr.Instance;

    readonly Job job;
    readonly TextBlock overall = Build.Text("", "Body");
    readonly TextBlock elapsed = Build.Text("", "Muted");
    readonly ProgressBar whole = new() { Height = 6, Minimum = 0, Maximum = 1, Margin = new Thickness(0, 12, 0, 16) };
    readonly StackPanel list = new();
    readonly StackPanel filtering;
    readonly Button stop;
    readonly Dictionary<string, Row> rows = new();
    readonly DispatcherTimer timer;

    public ProgressView(Job job)
    {
        this.job = job;
        stop = Build.Button(T["common.stop"], async () => await StopAsync(), "BtnDanger");
        stop.HorizontalAlignment = HorizontalAlignment.Right;
        stop.VerticalAlignment = VerticalAlignment.Top;
        var head = new DockPanel { Margin = new Thickness(0, 8, 0, 24) };
        DockPanel.SetDock(stop, Dock.Right);
        head.Children.Add(stop);
        head.Children.Add(Build.Heading(JobTitle(job)));
        overall.FontWeight = FontWeights.SemiBold;
        var dot = new Border { Width = 10, Height = 10, CornerRadius = new CornerRadius(5), Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center };
        dot.SetResourceReference(Border.BackgroundProperty, "Accent");
        elapsed.Margin = new Thickness(12, 0, 0, 0);
        var line = Build.Stack(Orientation.Horizontal, dot, overall, elapsed);
        whole.SetResourceReference(Control.ForegroundProperty, "Accent");
        whole.SetResourceReference(Control.BackgroundProperty, "Track");
        whole.BorderThickness = new Thickness(0);
        var spin = new Icon { Glyph = "arc", Width = 18, Height = 18, Margin = new Thickness(0, 0, 8, 0) };
        filtering = Build.Stack(Orientation.Horizontal, spin, Build.Text(T["progress.filtering"], "Muted"));
        filtering.Margin = new Thickness(0, 16, 0, 0);
        var card = Build.Card(Labeled.Group(JobTitle(job), list), 8);
        Content = Build.Page(Build.Stack(head, line, whole, card, filtering, Build.Text(T["progress.slow"], "Hint").Margin(0, 16, 0, 0)));
        timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += (_, _) => Tick();
        Loaded += (_, _) => timer.Start();
        Unloaded += (_, _) => timer.Stop();
        Tick();
        Update();
    }

    public Job Job => job;

    public static string TypeWords(IEnumerable<string> types) =>
        Formats.List(types.Select((t) => T.Has("type." + t) ? T["type." + t] : t));

    /// <summary>What a job searches for, as its heading says it.</summary>
    public static string JobTitle(Job job)
    {
        var r = job.Request;
        string? Str(string k) => r.ValueKind == JsonValueKind.Object && r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        if (job.Mode == "media") return T["progress.title.media"];
        if (job.Mode == "folder") return T.Get("progress.title.folder", ("folder", Str("folder") ?? ""));
        if (Str("pattern") is { Length: > 0 } name) return T.Get("progress.title.name", ("name", name));
        if (Str("containing") is { Length: > 0 } text) return T.Get("progress.title.containing", ("text", text));
        var types = r.ValueKind == JsonValueKind.Object && r.TryGetProperty("types", out var tv) && tv.ValueKind == JsonValueKind.Array
            ? tv.EnumerateArray().Select((x) => x.GetString() ?? "").ToList() : [];
        return T.Get("progress.title.type", ("type", TypeWords(types)));
    }

    public static string RowResult(SourceRow r)
    {
        if (r.Status == "failed") return T["progress.failed"];
        if (r.Status == "skipped") return T["progress.skipped"];
        if (r.Count > 0) return T.Get("progress.found", ("count", r.Count));
        return T["progress.nothing"];
    }

    void Tick()
    {
        var s = Math.Max(0, Math.Round((DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - job.StartedAt) / 1000));
        elapsed.Text = T.Get("fmt.elapsed", ("s", (long)s));
    }

    /// <summary>Draws the rows again as the job now stands.</summary>
    public void Update()
    {
        foreach (var r in job.Rows)
        {
            if (!rows.TryGetValue(r.Id, out var row))
            {
                rows[r.Id] = row = new Row();
                list.Children.Add(row.El);
            }
            row.Set(r);
        }
        int done = job.Rows.Count((r) => r.Status is "done" or "failed" or "skipped");
        overall.Text = T.Get("progress.overall", ("done", done), ("total", job.Rows.Count));
        whole.Maximum = Math.Max(1, job.Rows.Count);
        whole.Value = done;
        AutomationProperties.SetName(whole, overall.Text);
        filtering.Visibility = job.Filtering ? Visibility.Visible : Visibility.Collapsed;
    }

    async Task StopAsync()
    {
        stop.IsEnabled = false;
        stop.Content = T["common.stopping"];
        try
        {
            if (App.Session is { } s) await s.Jobs.StopAsync(job);
        }
        catch (Exception e) when (e is CoreException or HttpRequestException)
        {
            stop.IsEnabled = true;
            stop.Content = T["common.stop"];
            Announce.Alert(Formats.ErrorText(e));
        }
    }

    /// <summary>One place's row: an icon for how it stands, its name, and what it found or how far it is.</summary>
    sealed class Row
    {
        public Border El { get; }
        readonly Icon mark = new() { Width = 20, Height = 20, VerticalAlignment = VerticalAlignment.Center };
        readonly TextBlock label = Build.Text("", "Body");
        readonly TextBlock status = Build.Text("", "Muted");
        readonly ProgressBar bar = new() { Width = 160, Height = 4, Visibility = Visibility.Collapsed, Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        readonly TextBlock detail = Build.Text("", "Hint");
        readonly Button more;
        string? was;

        public Row()
        {
            label.FontWeight = FontWeights.SemiBold;
            label.Margin = new Thickness(16, 0, 16, 0);
            label.VerticalAlignment = VerticalAlignment.Center;
            status.VerticalAlignment = VerticalAlignment.Center;
            bar.SetResourceReference(Control.ForegroundProperty, "Accent");
            bar.SetResourceReference(Control.BackgroundProperty, "Track");
            bar.BorderThickness = new Thickness(0);
            more = Build.Button(T["common.details"], () => detail.Visibility = detail.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible, "BtnQuiet");
            more.MinHeight = 32;
            more.Padding = new Thickness(12, 4, 12, 4);
            more.Visibility = Visibility.Collapsed;
            more.Margin = new Thickness(8, 0, 0, 0);
            detail.Visibility = Visibility.Collapsed;
            detail.Margin = new Thickness(36, 8, 0, 0);
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.Children.Add(mark);
            Grid.SetColumn(label, 1);
            grid.Children.Add(label);
            var state = Build.Stack(Orientation.Horizontal, status, bar, more);
            Grid.SetColumn(state, 2);
            grid.Children.Add(state);
            El = new Border { Child = Build.Stack(grid, detail), Padding = new Thickness(16, 14, 16, 14), CornerRadius = new CornerRadius(14) };
        }

        public void Set(SourceRow r)
        {
            if (was != r.Status)
            {
                was = r.Status;
                mark.Glyph = r.Status switch { "running" => "arc", "done" => "check", "failed" => "alert", "skipped" => "minus", _ => "circle" };
                mark.SetResourceReference(Icon.ForegroundProperty, r.Status switch
                {
                    "running" => "Accent",
                    "done" => "Success",
                    "failed" => "DangerText",
                    _ => "Text2",
                });
            }
            label.Text = Formats.SourceLabel(r.Id, r.Label);
            if (r.Status == "waiting") status.Text = r.Id == "vss" ? T["progress.vssLast"] : T["progress.waiting"];
            else if (r.Status != "running") status.Text = RowResult(r);
            else if (r.Total > 0) status.Text = T.Get("progress.files", ("done", r.Done), ("total", r.Total));
            else status.Text = T["progress.running"];
            bool showBar = r.Status == "running" && r.Total > 0;
            bar.Visibility = showBar ? Visibility.Visible : Visibility.Collapsed;
            if (showBar)
            {
                bar.Maximum = r.Total;
                bar.Value = r.Done;
                AutomationProperties.SetName(bar, T.Get("a11y.progressValue", ("source", label.Text), ("done", r.Done), ("total", r.Total)));
            }
            more.Visibility = r.Status == "failed" && r.Error is not null ? Visibility.Visible : Visibility.Collapsed;
            detail.Text = r.Error ?? "";
            AutomationProperties.SetName(El, $"{label.Text}: {status.Text}");
        }
    }
}

/// <summary>
/// A view that says one thing: an icon, a heading, what happened, and what can be done (statePage
/// in app.js); and the ones a search ends in when it finds nothing to show: failed, or stopped.
/// </summary>
public static class StatePage
{
    static Tr T => Tr.Instance;

    public static FrameworkElement Make(string kind, string title, params UIElement?[] body)
    {
        var glyph = kind switch { "error" => "error", "stopped" => "stop", "success" => "success", "empty" => "search", _ => "info" };
        var colour = kind switch { "error" => "DangerText", "success" => "Success", _ => "AccentText" };
        var icon = new Icon { Glyph = glyph, Width = 32, Height = 32 };
        icon.SetResourceReference(Icon.ForegroundProperty, colour);
        var badge = new Border { Width = 64, Height = 64, CornerRadius = new CornerRadius(20), Child = icon, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 0, 24, 0) };
        badge.SetResourceReference(Border.BackgroundProperty, kind == "error" ? "ErrorBg" : kind == "success" ? "SuccessBg" : "AccentSoft");
        var words = Build.Stack(Build.Heading(title));
        foreach (var b in body) if (b is not null) words.Children.Add(b);
        // As the page's state-page: a column of its own, in the middle of the part.
        var dock = new DockPanel { Margin = new Thickness(0, 24, 0, 0), MaxWidth = 880, HorizontalAlignment = HorizontalAlignment.Center };
        DockPanel.SetDock(badge, Dock.Left);
        dock.Children.Add(badge);
        dock.Children.Add(words);
        return dock;
    }

    /// <summary>A row of buttons, as the page's .actions.</summary>
    public static WrapPanel Actions(params Button?[] buttons)
    {
        var w = new WrapPanel { Margin = new Thickness(0, 16, 0, 0) };
        foreach (var b in buttons)
        {
            if (b is null) continue;
            b.Margin = new Thickness(0, 0, 8, 8);
            w.Children.Add(b);
        }
        return w;
    }

    /// <summary>
    /// That what the library said of a job is in the language it spoke when the job was made, when
    /// that is not the one it speaks now; null when it is, or when nothing it said is shown.
    /// </summary>
    public static TextBlock? OldLanguage(Job job, bool said)
    {
        var now = App.Session?.Locale;
        if (!said || job.Lang is null || now is null || job.Lang == now) return null;
        return Build.Text(T["results.oldLanguage"], "Hint").Margin(0, 8, 0, 0);
    }

    public static FrameworkElement Failed(Job job, Action again, Action back) => Build.Page(Make("error", T["error.title"],
        Build.Text(job.Error is not null ? T.Get("progress.failedBecause", ("message", job.Error)) : T["error.unexpected"], "Lead").Margin(0, 12, 0, 0),
        OldLanguage(job, job.Error is not null),
        Actions(Build.Button(T["common.retry"], again, "BtnPrimary"), Build.Button(T["common.back"], back))));

    public static FrameworkElement Stopped(Job job, Action again, Action back) => Build.Page(Make("stopped", T["progress.stopped.title"],
        Build.Text(T["progress.stopped.body"], "Lead").Margin(0, 12, 0, 0),
        Actions(Build.Button(T["common.searchAgain"], again, "BtnPrimary"), Build.Button(T["common.back"], back))));

    /// <summary>A search that is done, while its results are asked for.</summary>
    public static FrameworkElement Loading(Job job, Action retry)
    {
        if (job.LoadError is { } e)
        {
            return Build.Page(Build.Stack(Build.Heading(ProgressView.JobTitle(job)),
                Build.Callout("error", T["error.title"], Build.Text(Formats.ErrorText(e), "Body")),
                Actions(Build.Button(T["common.retry"], retry, "BtnPrimary"))));
        }
        return Build.Page(Build.Stack(Build.Heading(ProgressView.JobTitle(job)),
            Build.Text(T.Get("results.loading", ("count", job.Received), ("total", job.Total ?? 0)), "Muted").Margin(0, 16, 0, 0)));
    }

    /// <summary>
    /// Places that could not be searched, and what each place and the search had to say, in words
    /// and under a card that opens (searchNotices in app.js).
    /// </summary>
    public static StackPanel Notices(Job job)
    {
        var out_ = new StackPanel { Margin = new Thickness(0, 0, 0, 16) };
        var per = job.Said("perSource") is { ValueKind: JsonValueKind.Array } p ? p.EnumerateArray().ToList() : [];
        string Str(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var failed = per.Where((s) => Str(s, "error").Length > 0).ToList();
        var noted = per.Where((s) => s.TryGetProperty("notes", out var n) && n.ValueKind == JsonValueKind.Array && n.GetArrayLength() > 0).ToList();
        var general = job.Said("notes") is { ValueKind: JsonValueKind.Array } g ? g.EnumerateArray().Select((x) => x.ToString()).ToList() : [];
        if (failed.Count > 0)
        {
            var lines = failed.Select((s) => (UIElement)Line(Formats.SourceLabel(Str(s, "id"), Str(s, "label")), Str(s, "error"))).ToArray();
            out_.Children.Add(Build.Callout("warn", T.Get("results.failedPlaces", ("count", failed.Count)), lines));
        }
        if (noted.Count > 0 || general.Count > 0)
        {
            var items = new List<UIElement>();
            foreach (var n in general) items.Add(Build.Text("• " + n, "Body").Margin(0, 4, 0, 0));
            foreach (var s in noted)
                foreach (var n in s.GetProperty("notes").EnumerateArray())
                    items.Add(Line(Formats.SourceLabel(Str(s, "id"), Str(s, "label")), n.ToString()));
            out_.Children.Add(Build.More(T["results.notes"], false, false, items.ToArray()));
        }
        if (OldLanguage(job, failed.Count + noted.Count + general.Count > 0) is { } lang) out_.Children.Add(lang);
        return out_;
    }

    /// <summary>"• Name: what it said", the name bold.</summary>
    static TextBlock Line(string name, string said)
    {
        var tb = Build.Text("", "Body");
        tb.Margin = new Thickness(0, 4, 0, 0);
        tb.Inlines.Add(new System.Windows.Documents.Run("• "));
        tb.Inlines.Add(new System.Windows.Documents.Run(name) { FontWeight = FontWeights.Bold });
        tb.Inlines.Add(new System.Windows.Documents.Run(": " + said));
        return tb;
    }
}
