using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Sources;

namespace Solarljos.Views;

/// <summary>
/// What is searched (viewSources in app.js): one card per source -- what it keeps and for how
/// long, whether it needs administrator rights, what it sees on this PC (its describe() lines, in
/// notes that open), and the places added to it for this run: a folder on another disk, a memory
/// card's image, a folder for every restore point to be looked through. Those are the session's,
/// in memory only, and every search sends them; "search only the places I added" leaves this PC's
/// own out.
/// </summary>
public sealed class SourcesView : UserControl, IPage
{
    static Tr T => Tr.Instance;

    sealed class Card
    {
        public required StackPanel Lines { get; init; }
        public required StackPanel Added { get; init; }
        /// <summary>The places added, as a list (the page's ul.added); out of sight while there are none.</summary>
        public required Labeled AddedList { get; init; }
        public required Button Add { get; init; }
    }

    readonly ScrollViewer scroll;
    readonly Border holder;
    readonly Dictionary<string, Card> cards = new();
    // Whose notes are open, kept when the cards are made again in another language.
    readonly HashSet<string> notesOpen = new();
    Session? session;
    Build.SwitchRow? onlyAdded;
    // What each source sees here, as the engine last said it; null until it has.
    Dictionary<string, List<string>>? lines;
    string? describeError;
    int describeSeq;

    public event Action? HeadingChanged;

    public SourcesView()
    {
        Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("/Solarljos;component/Views/Sources/SourcesLook.xaml", UriKind.Relative) });
        scroll = Build.Page(new StackPanel());
        holder = (Border)scroll.Content;
        Content = scroll;
        Render();
        T.Changed += () =>
        {
            Render();
            HeadingChanged?.Invoke();
            _ = DescribeAsync(again: true);
        };
    }

    public string? Heading => T["sources.title"];

    public void Connected(Session s)
    {
        session = s;
        Render();
        _ = DescribeAsync(again: false);
    }

    /// <summary>
    /// Another part may have changed the places added -- a card's image, from a search's form --
    /// and whether this PC's own are searched: shown as they are now.
    /// </summary>
    public void Shown(string sub)
    {
        if (session is null) return;
        if (onlyAdded is not null) onlyAdded.IsOn = !session.Discover;
        RenderAdded();
    }

    // ---- the page ---------------------------------------------------------------------------

    void Render()
    {
        cards.Clear();
        var head = Build.Stack(Build.Heading(T["sources.title"]), Build.Text(T["sources.intro"], "Lead").Margin(0, 8, 0, 0));
        head.Margin = new Thickness(0, 8, 0, 24);
        var page = Build.Stack(head);
        holder.Child = page;
        if (session is not { } s) return;
        if (s.Elevated) page.Children.Add(Build.Callout("info", null, Build.Text(T["sources.elevated"])).Margin(0, 0, 0, 16));

        var only = Build.Switch(T["sources.onlyAdded"], !s.Discover);
        only.Changed += () => s.Discover = !only.IsOn;
        onlyAdded = only;
        var panel = Build.Card(only.El);
        panel.Padding = new Thickness(24, 10, 24, 10);
        panel.Margin = new Thickness(0, 0, 0, 16);
        page.Children.Add(panel);

        var grid = new CardGrid();
        foreach (var source in s.Sources) grid.Children.Add(MakeCard(s, source));
        page.Children.Add(grid);
        RenderLines();
        RenderAdded();
    }

    FrameworkElement MakeCard(Session s, Session.SourceInfo source)
    {
        var label = Formats.SourceLabel(source.Id, source.Label);
        var body = Build.Stack(Build.Heading(label, 2).Margin(0, 0, 0, 8));
        if (T.Has($"source.{source.Id}.keeps")) body.Children.Add(Terms(source.Id));
        if (source.NeedsAdmin && !s.Elevated) body.Children.Add(Bits.NoteLine("alert", T["sources.needsAdmin"]));
        if (!source.Media) body.Children.Add(Bits.NoteLine("info", T["sources.textOnly"]));
        if (ReadAhead(s, source.Id) is { } read) body.Children.Add(Bits.NoteLine(read.Failed ? "alert" : "info", read.Text));

        var linesBox = new StackPanel();
        // The keyboard stops at its link, not at the expander around it as well.
        var notes = new Expander { Header = T["sources.technical"], Content = linesBox, IsExpanded = notesOpen.Contains(source.Id), Focusable = false };
        notes.SetResourceReference(StyleProperty, "NotesExpander");
        AutomationProperties.SetName(notes, T["sources.technical"]);
        notes.Expanded += (_, _) => notesOpen.Add(source.Id);
        notes.Collapsed += (_, _) => notesOpen.Remove(source.Id);
        body.Children.Add(notes);
        var added = new StackPanel();
        var addedList = new Labeled { Kind = AutomationControlType.List, Child = added, Margin = new Thickness(0, 4, 0, 0), Visibility = Visibility.Collapsed };
        body.Children.Add(addedList);

        Button? add = null;
        add = Bits.Small(Build.Button(T["sources.add"], () => AddPlace(source, add!)));
        // Every card has this button: it says which source it adds to.
        AutomationProperties.SetHelpText(add, T.Get("sources.addTitle", ("source", label)));
        add.Margin = new Thickness(0, 16, 0, 0);
        add.VerticalAlignment = VerticalAlignment.Bottom;

        // The button at the card's foot, however tall its row makes it, and last in the Tab order.
        var layout = new Grid();
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(add, 1);
        layout.Children.Add(body);
        layout.Children.Add(add);
        cards[source.Id] = new Card { Lines = linesBox, Added = added, AddedList = addedList, Add = add };
        return new Region(label) { Child = layout };
    }

    /// <summary>What it keeps and for how long, a term and its words in two columns (dl.info).</summary>
    static Grid Terms(string id)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, MinWidth = 96 });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        foreach (var (term, key) in new[] { ("sources.keeps", $"source.{id}.keeps"), ("sources.howLong", $"source.{id}.howLong") })
        {
            if (!T.Has(key)) continue;
            int row = grid.RowDefinitions.Count;
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var top = row == 0 ? 0 : 8;
            var dt = Build.Text(T[term], "Muted").Margin(0, top, 16, 0);
            var dd = Build.Text(T[key]).Margin(0, top, 0, 0);
            foreach (var t in new[] { dt, dd })
            {
                t.FontSize = 14;
                t.LineHeight = 21;
            }
            Grid.SetRow(dt, row);
            Grid.SetRow(dd, row);
            Grid.SetColumn(dd, 1);
            grid.Children.Add(dt);
            grid.Children.Add(dd);
        }
        return grid;
    }

    /// <summary>
    /// What the engine read of this source ahead, before the window opened (api/info's frozen):
    /// when, or why it could not.
    /// </summary>
    static (string Text, bool Failed)? ReadAhead(Session s, string id)
    {
        if (!s.Info.TryGetProperty("frozen", out var frozen) || frozen.ValueKind != JsonValueKind.Object) return null;
        if (!frozen.TryGetProperty("sources", out var list) || list.ValueKind != JsonValueKind.Array) return null;
        foreach (var read in list.EnumerateArray())
        {
            if (!read.TryGetProperty("id", out var rid) || rid.ValueKind != JsonValueKind.String || rid.GetString() != id) continue;
            var error = read.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            if (!string.IsNullOrEmpty(error)) return (T.Get("sources.frozenFailed", ("error", error)), true);
            DateTimeOffset? at = frozen.TryGetProperty("at", out var a) && a.ValueKind == JsonValueKind.Number
                ? DateTimeOffset.FromUnixTimeMilliseconds((long)a.GetDouble()) : null;
            return (T.Get("sources.frozen", ("when", Formats.When(at))), false);
        }
        return null;
    }

    // ---- what each source sees here --------------------------------------------------------

    /// <summary>
    /// Asks the engine what each source sees on this PC, which may take a moment for restore
    /// points. After a change of language it is asked again once the engine speaks the new one,
    /// since the lines are its own words.
    /// </summary>
    async Task DescribeAsync(bool again)
    {
        if (session is not { } s || s.Sources.Count == 0) return;
        int mine = ++describeSeq;
        if (again) await s.UseLanguageAsync(T.Code);
        if (mine != describeSeq) return;
        try
        {
            var ids = string.Join(",", s.Sources.Select((x) => x.Id));
            var d = await s.Client.GetAsync("/api/sources/describe?ids=" + Uri.EscapeDataString(ids));
            if (mine != describeSeq) return;
            var got = new Dictionary<string, List<string>>();
            if (d.TryGetProperty("sources", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var g in list.EnumerateArray())
                {
                    if (!g.TryGetProperty("id", out var id) || id.GetString() is not { } key) continue;
                    got[key] = g.TryGetProperty("lines", out var ls) && ls.ValueKind == JsonValueKind.Array
                        ? ls.EnumerateArray().Select((l) => l.ValueKind == JsonValueKind.String ? l.GetString() ?? "" : l.ToString()).ToList()
                        : [];
                }
            }
            lines = got;
            describeError = null;
        }
        catch (Exception e) when (e is CoreException or HttpRequestException or TaskCanceledException or JsonException)
        {
            if (mine != describeSeq) return;
            describeError = Formats.ErrorText(e);
        }
        RenderLines();
    }

    void RenderLines()
    {
        foreach (var (id, c) in cards)
        {
            c.Lines.Children.Clear();
            if (describeError is not null)
                c.Lines.Children.Add(Small(T.Get("sources.describeFailed", ("message", describeError))));
            else if (lines is null)
                c.Lines.Children.Add(Small(T["sources.checking"]));
            else if (!lines.TryGetValue(id, out var ls) || ls.Count == 0)
                c.Lines.Children.Add(Small(T["sources.noLines"]));
            else
                c.Lines.Children.Add(Build.Bullets(ls, 13, 20, ownWay: true));
        }

        static TextBlock Small(string text)
        {
            var t = Build.Text(text, "Muted");
            t.FontSize = 14;
            t.LineHeight = 21;
            return t;
        }
    }

    // ---- the places added for this run -----------------------------------------------------

    void RenderAdded()
    {
        if (session is not { } s) return;
        foreach (var (id, c) in cards)
        {
            c.Added.Children.Clear();
            var places = s.Added.TryGetValue(id, out var some) ? some.ToList() : [];
            c.AddedList.Visibility = places.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            foreach (var place in places)
            {
                // A folder for every restore point is shown as that folder; any other place is a path.
                bool walk = id == "vss" && place.StartsWith("walk=", StringComparison.Ordinal);
                var what = Build.Text(walk ? T.Get("sources.walkPlace", ("folder", place[5..])) : place);
                if (!walk) what.FlowDirection = FlowDirection.LeftToRight;
                what.Margin = new Thickness(0, 0, 8, 0);
                var said = Build.Text(T["sources.added"] + ": ", "Muted");
                said.Margin = new Thickness(0, 0, 4, 0);
                // Their lines as tall as the type, so that the words sit level with the button's.
                foreach (var t in new[] { said, what })
                {
                    t.LineHeight = double.NaN;
                    t.VerticalAlignment = VerticalAlignment.Center;
                }
                var remove = Bits.Small(Build.Button(T["sources.remove"], () => RemovePlace(id, place), "BtnQuiet"));
                AutomationProperties.SetHelpText(remove, walk ? place[5..] : place);
                var row = new WrapPanel();
                row.Children.Add(said);
                row.Children.Add(what);
                row.Children.Add(remove);
                // An item of the list, as the page's li: what it says, and its button, are in it.
                c.Added.Children.Add(new Labeled { Kind = AutomationControlType.ListItem, Child = row, Margin = new Thickness(0, 4, 0, 0) });
            }
        }
    }

    void AddPlace(Session.SourceInfo source, Button opener)
    {
        if (Window.GetWindow(this) is not { } owner) return;
        var dlg = new AddPlaceDialog(owner, source);
        dlg.ShowDialog();
        if (dlg.Place is { } place) Added(source, place);
        else opener.Focus();
    }

    /// <summary>A place added to a source: kept for the run, once, and said.</summary>
    void Added(Session.SourceInfo source, string place)
    {
        if (session is not { } s) return;
        if (!s.Added.TryGetValue(source.Id, out var list)) s.Added[source.Id] = list = new List<string>();
        if (!list.Contains(place)) list.Add(place);
        RenderAdded();
        if (cards.TryGetValue(source.Id, out var c)) c.Add.Focus();
        Announce.Say(T.Get("sources.addedNow", ("source", Formats.SourceLabel(source.Id, source.Label))));
    }

    void RemovePlace(string id, string place)
    {
        if (session is not { } s) return;
        if (s.Added.TryGetValue(id, out var list))
        {
            list.Remove(place);
            if (list.Count == 0) s.Added.Remove(id);
        }
        RenderAdded();
        // Its button is gone: the keyboard goes on from the card's own.
        if (cards.TryGetValue(id, out var c)) c.Add.Focus();
        Announce.Say(T.Get("sources.removedNow", ("source", Formats.SourceLabel(id))));
    }

    // ---- for the pictures of the window ----------------------------------------------------

    /// <summary>
    /// What to do before a picture, one or more of these, joined by "|": "add:jetbrains=D:\old" (a
    /// place added as if typed), "notes:git" or "notes:all" (opened), "only" (only the places
    /// added), "dialog:vss" (the dialog, left open), "dialog:vss=Pictures" (typed and Add pressed),
    /// "remove:jetbrains" (its first place removed), "lang:ar" (another language, from the
    /// rail's list), "scroll:600" or "scroll:end".
    /// </summary>
    public async Task ActAsync(string act)
    {
        if (session is not { } s) return;
        foreach (var one in act.Split('|', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = one.Split(':', 2);
            var arg = parts.Length > 1 ? parts[1] : "";
            var kv = arg.Split('=', 2);
            var source = s.Sources.FirstOrDefault((x) => x.Id == kv[0]);
            switch (parts[0])
            {
                case "add" when source is not null && kv.Length == 2:
                    Added(source, source.Id == "vss" ? "walk=" + kv[1] : kv[1]);
                    break;
                case "remove" when s.Added.TryGetValue(kv[0], out var list) && list.Count > 0:
                    RemovePlace(kv[0], list[0]);
                    break;
                case "notes":
                    foreach (var id in kv[0] == "all" ? cards.Keys.ToList() : [kv[0]]) notesOpen.Add(id);
                    Render();
                    break;
                case "only":
                    if (onlyAdded is not null) onlyAdded.IsOn = true;
                    break;
                case "dialog" when source is not null && Window.GetWindow(this) is { } owner:
                    {
                        var dlg = new AddPlaceDialog(owner, source);
                        dlg.Closed += (_, _) =>
                        {
                            if (dlg.Place is { } place) Added(source, place);
                        };
                        dlg.Show();
                        await Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
                        if (kv.Length == 2) dlg.Type(kv[1], submit: true);
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
