using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Sources;

namespace Solarljos.Views;

/// <summary>
/// Help (viewHelp in app.js): each part a card that opens when its title is clicked, as
/// SoundVisualizer's help is, only the first open at first; what the labels mean, each beside its
/// badge; and the version. Which parts are open stays when the words are made again in another
/// language. The page's part on the browser window does not apply to a program of its own: in
/// its place is what does, the window's own.
/// </summary>
public sealed class HelpView : UserControl, IPage
{
    static Tr T => Tr.Instance;

    static readonly string[] Tiers = ["exact", "inexact", "draft", "unverified", "derived", "folder", "gone"];
    static readonly string[] States = ["deleted", "exists", "no content", ""];

    readonly ScrollViewer scroll;
    readonly Border holder;
    readonly HashSet<int> open = [0];
    readonly List<Expander> parts = new();
    Session? session;

    public event Action? HeadingChanged;

    public HelpView()
    {
        scroll = Build.Page(new StackPanel(), maxWidth: 880);
        holder = (Border)scroll.Content;
        Content = scroll;
        Render();
        T.Changed += () =>
        {
            Render();
            HeadingChanged?.Invoke();
        };
    }

    public string? Heading => T["help.title"];

    public void Connected(Session s)
    {
        session = s;
        Render();
    }

    void Render()
    {
        parts.Clear();
        var page = Build.Stack(Build.Heading(T["help.title"]).Margin(0, 8, 0, 24));
        page.Children.Add(Part("help.what.title", Bits.Para(T["help.what.body"], first: true)));
        page.Children.Add(Part("help.tiers.title", Legend(Tiers.Select((t) => ((UIElement)TierBadge(t), T[$"tier.{t}.help"])))));
        page.Children.Add(Part("help.states.title", Legend(States.Select((s) => ((UIElement)Build.StateBadge(s), Formats.StateHelp(s))))));
        page.Children.Add(Part("help.media.title",
            Bits.Para(T["help.media.ssd"], first: true), Bits.Para(T["help.media.video"]), Bits.Para(T["help.media.card"])));
        page.Children.Add(Part("help.cant.title", Bits.Bullets(new[] { "help.cant.formatted", "help.cant.nocopy", "help.cant.original" }.Select((k) => T[k]))));
        page.Children.Add(Part("help.writes.title", Bits.Para(T["help.writes.body"], first: true)));
        page.Children.Add(Part("help.stop.title", Bits.Para(T["help.stop.body"], first: true)));
        // The page's help.browser.* say how the browser keeps the page; this window is no browser's.
        page.Children.Add(Part("desktop.help.window.title", Bits.Para(T["desktop.help.window.body"], first: true)));
        page.Children.Add(Part("help.keys.title", Bits.Para(T["help.keys.body"], first: true), Bits.Para(T["desktop.help.keys.rail"])));
        if (Version() is { } version) page.Children.Add(Build.Text(T.Get("help.version", ("version", version)), "Muted").Margin(0, 8, 0, 0));
        holder.Child = page;
    }

    string? Version() =>
        session is { } s && s.Info.ValueKind == JsonValueKind.Object && s.Info.TryGetProperty("version", out var v)
            && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } text ? text : null;

    /// <summary>A part of help, a card that opens, as it was left: open or closed.</summary>
    Expander Part(string titleKey, params UIElement[] body)
    {
        int i = parts.Count;
        var e = Build.More(T[titleKey], open.Contains(i), card: true, body);
        e.Margin = new Thickness(0, 0, 0, 16);
        // The keyboard stops at its title, not at the card around it as well.
        e.Focusable = false;
        // Its title is a heading, as the page's summary holds an h2.
        AutomationProperties.SetHeadingLevel(e, AutomationHeadingLevel.Level2);
        e.Expanded += (_, _) => open.Add(i);
        e.Collapsed += (_, _) => open.Remove(i);
        parts.Add(e);
        return e;
    }

    /// <summary>A label and what it means, in two columns (dl.info.legend): at least 160 pixels for the labels.</summary>
    static Grid Legend(IEnumerable<(UIElement Term, string Means)> rows)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, MinWidth = 160 });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        foreach (var (term, means) in rows)
        {
            int row = grid.RowDefinitions.Count;
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            double top = row == 0 ? 0 : 12;
            var cell = new Border { Child = term, Margin = new Thickness(0, top, 20, 0), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top };
            if (term is FrameworkElement fe) fe.VerticalAlignment = VerticalAlignment.Top;
            var words = Build.Text(means).Margin(0, top, 0, 0);
            Grid.SetRow(cell, row);
            Grid.SetRow(words, row);
            Grid.SetColumn(words, 1);
            grid.Children.Add(cell);
            grid.Children.Add(words);
        }
        return grid;
    }

    /// <summary>A label of the legend: a tier's pill, with its icon and its words, in its colours.</summary>
    static Border TierBadge(string tier)
    {
        var colours = tier switch
        {
            "exact" => "Exact",
            "inexact" => "Inexact",
            "draft" => "Draft",
            "unverified" => "Unverified",
            "derived" => "Derived",
            _ => "Neutral",
        };
        return Bits.Upright(Build.Badge(colours, Formats.TierIcon(tier), T[$"tier.{tier}"]));
    }

    // ---- for the pictures of the window ----------------------------------------------------

    /// <summary>
    /// What to do before a picture, joined by "|": "open:2" or "close:1" (a part by its place,
    /// from 1), "open:all", "lang:ar" (another language, from the rail's list), "scroll:600" or
    /// "scroll:end".
    /// </summary>
    public async Task ActAsync(string act)
    {
        foreach (var one in act.Split('|', StringSplitOptions.RemoveEmptyEntries))
        {
            var bits = one.Split(':', 2);
            var arg = bits.Length > 1 ? bits[1] : "";
            switch (bits[0])
            {
                case "open" or "close":
                    {
                        bool to = bits[0] == "open";
                        IEnumerable<int> which = arg == "all" ? Enumerable.Range(0, parts.Count)
                            : int.TryParse(arg, out var n) && n >= 1 && n <= parts.Count ? [n - 1] : [];
                        foreach (var i in which) parts[i].IsExpanded = to;
                        break;
                    }
                case "lang" when Window.GetWindow(this) is MainWindow w:
                    w.Lang.SelectedValue = arg;
                    await Task.Delay(400);
                    break;
                case "scroll":
                    await Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
                    if (arg == "end") scroll.ScrollToEnd();
                    else if (double.TryParse(arg, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var y)) scroll.ScrollToVerticalOffset(y);
                    break;
            }
        }
    }
}
