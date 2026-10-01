using System.Collections.ObjectModel;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Media;

/// <summary>
/// The photo and video grid (gridView in src/gui/ui/app.js). Tiles are grouped by the month of
/// their date, as the copies come, with copies that carry no date in a group of their own --
/// never hidden, whatever the dates chosen, since a thumbnail whose file is unknown has no date
/// and may be the one photo left. The choices above it -- the original or the smaller copies too,
/// the place, tiny pictures, the dates and the folder of the search -- work on what the program
/// holds, and say how many copies each hides, with a way to show them. The grid is one control to
/// the keyboard: Tab enters it once, the arrow keys move, Space selects, Shift+Space selects a
/// range, Enter opens; the mouse selects with Ctrl and Shift, or with a tile's box. What is
/// selected is restored together. `saved` is what it held when it is made again in another
/// language: its choices, how many tiles were shown, what was selected, where it was scrolled.
/// </summary>
public sealed class MediaGrid : UserControl
{
    static Tr T => Tr.Instance;

    public sealed record State(bool Smaller, bool HideTiny, string Source, bool AllDates, bool AllPlaces, int Shown, List<string> Selected, double Scroll);

    sealed class Group(string key, string? month)
    {
        public string Key { get; } = key;
        public string? Month { get; } = month;
        public List<Copy> Tiles { get; } = new();
    }

    /// <summary>A month's heading in the list of rows; `Gen` changes whenever the grid is drawn anew.</summary>
    sealed record MonthItem(int Gen, string Key, string? Month);

    /// <summary>A row of tiles: the `Count` tiles of a group from `Index` × `Cols`.</summary>
    sealed record RowItem(int Gen, string Key, int Index, int Count, int Cols);

    readonly MediaView owner;
    readonly Session session;
    readonly Job job;
    readonly MediaRequest r;
    readonly Thumbs thumbs;
    readonly ResourceDictionary look;
    readonly List<Copy> items;

    // The choices, and what they keep.
    bool smaller;
    bool hideTiny;
    string source;
    bool allDates;
    bool allPlaces;
    List<Copy> list = new();
    readonly Dictionary<string, Copy> inList = new();
    int shown;
    int cols = 4;
    int gen;
    List<(string? Month, int Count)> months = new();
    readonly List<Group> groups = new();
    readonly Dictionary<string, Group> groupOf = new();
    List<Copy> order = new();
    readonly Dictionary<string, int> place = new();
    readonly List<(Group G, int Row)> rowsOf = new();

    // What is selected, where a range starts, and the tile Tab comes back to.
    readonly OrderedDictionary<string, Copy> selected = new();
    string? anchor;
    string? focus;

    // What it is drawn with.
    readonly GridList grid = new();
    readonly ObservableCollection<object> rows = new();
    readonly StackPanel header;
    readonly TextBlock summary = Build.Text("", "Muted");
    readonly StackPanel hiddenNote = new();
    readonly Build.Chips size;
    readonly Build.SwitchRow tiny;
    readonly Build.SwitchRow dates;
    readonly Build.SwitchRow folderSwitch;
    readonly ComboBox sourceSel;
    readonly ComboBox jump;
    readonly Border moreRow;
    readonly Button moreButton;
    readonly Border bottom = new() { Height = 96 };
    readonly SilentText stickyText = new();
    readonly Border sticky;
    readonly Border bar;
    readonly TextBlock selCount = Build.Text("", "Body");
    readonly Dictionary<string, Tile> live = new();
    readonly Stack<Tile> pool = new();
    readonly DropShadowEffect barShadow = new() { BlurRadius = 24, ShadowDepth = 8, Direction = 270 };
    bool quiet;
    bool tabPending;
    bool morePending;
    bool fitPending;
    bool drawn;

    public TextBlock Title { get; }

    /// <summary>The lightbox open now, if any: for the pictures of the window.</summary>
    public Lightbox? Open { get; private set; }

    public MediaGrid(MediaView owner, Session session, Job job, Thumbs thumbs, ResourceDictionary look, State? saved)
    {
        this.owner = owner;
        this.session = session;
        this.job = job;
        this.thumbs = thumbs;
        this.look = look;
        r = MediaRequest.Of(job);
        items = job.Copies().ToList();
        var byUid = new Dictionary<string, Copy>();
        foreach (var c in items) byUid.TryAdd(c.Uid, c);
        smaller = saved?.Smaller ?? r.IncludeSmaller;
        hideTiny = saved?.HideTiny ?? true;
        source = saved?.Source ?? "";
        allDates = saved?.AllDates ?? false;
        allPlaces = saved?.AllPlaces ?? false;
        foreach (var uid in saved?.Selected ?? []) if (byUid.TryGetValue(uid, out var c)) selected[uid] = c;

        // ---- the heading, what was found, and the choices ----
        Title = Build.Heading(T["grid.title"]);
        MediaView.FocusableHeading(Title);
        summary.FontSize = 16;
        summary.Margin = new Thickness(0, 8, 0, 0);
        var newSearch = Build.Button(T["common.newSearch"], () => owner.ShowForm(true));
        newSearch.VerticalAlignment = VerticalAlignment.Top;
        newSearch.Margin = new Thickness(16, 2, 0, 0);
        var head = new DockPanel { Margin = new Thickness(0, 8, 0, 24) };
        DockPanel.SetDock(newSearch, Dock.Right);
        head.Children.Add(newSearch);
        head.Children.Add(Build.Stack(Title, summary));

        size = Build.ChipGroup(T["grid.filter.size"], [("full", T["grid.filter.full"]), ("smaller", T["grid.filter.smaller"])],
            smaller ? "smaller" : "full", null, inline: true);
        size.Changed += () =>
        {
            if (quiet) return;
            smaller = size.Value == "smaller";
            Render(true);
        };
        tiny = Build.Switch(T.Get("grid.filter.minSize", ("px", MediaData.TinyPx)), hideTiny, null, compact: true);
        tiny.Changed += () =>
        {
            if (quiet) return;
            hideTiny = tiny.IsOn;
            Render(true);
        };
        bool hasDates = r.From is not null || r.To is not null;
        dates = Build.Switch(T["results.allDates"], allDates, null, compact: true);
        dates.Changed += () =>
        {
            if (quiet) return;
            allDates = dates.IsOn;
            Render(true);
        };
        folderSwitch = Build.Switch(T.Get("results.allPlaces", ("folder", r.Where)), allPlaces, null, compact: true);
        folderSwitch.Changed += () =>
        {
            if (quiet) return;
            allPlaces = folderSwitch.IsOn;
            Render(true);
        };
        var found = PerSource().Where((x) => Num(x, "count") > 0).ToList();
        var froms = new List<(string, string)> { ("", T["grid.filter.allSources"]) };
        froms.AddRange(found.Select((x) => (Str(x, "id"), Formats.SourceLabel(Str(x, "id"), Str(x, "label")))));
        sourceSel = Build.Select(froms, source, T["grid.filter.from"]);
        sourceSel.SelectionChanged += (_, _) =>
        {
            if (quiet || sourceSel.SelectedValue is not string v) return;
            source = v;
            Render(true);
        };
        jump = Build.Select([("", T["grid.jumpPick"])], "", T["grid.jump"]);
        jump.SelectionChanged += (_, _) =>
        {
            // Chosen with the list open: when it closes, as a click on a month does.
            if (quiet || jump.IsDropDownOpen) return;
            Jumped();
        };
        jump.DropDownClosed += (_, _) => Jumped();
        foreach (var box in new[] { sourceSel, jump })
        {
            box.MinHeight = 40;
            box.SetResourceReference(Control.BackgroundProperty, "Card");
        }
        var toolbar = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
        Add(toolbar, size.El);
        if (found.Count > 1) Add(toolbar, Labeled(T["grid.filter.from"], sourceSel));
        Add(toolbar, Labeled(T["grid.jump"], jump));
        var toggles = new WrapPanel { Margin = new Thickness(0, 0, 0, 8) };
        toggles.Children.Add(tiny.El.Margin(0, 0, 8, 4));
        if (hasDates) toggles.Children.Add(dates.El.Margin(0, 0, 8, 4));
        if (r.Where.Length > 0) toggles.Children.Add(folderSwitch.El.Margin(0, 0, 8, 4));
        var keys = Build.Text(T["grid.keys"], "Hint").Margin(0, 0, 0, 8);
        header = Build.Stack(head, StatePage.Notices(job), hiddenNote, toolbar, toggles, keys);
        header.Margin = new Thickness(40, 40, 40, 0);

        moreButton = Build.Button("", () => ShowMore());
        moreButton.HorizontalAlignment = HorizontalAlignment.Center;
        moreRow = new Border { Child = moreButton, Margin = new Thickness(40, 16, 40, 0) };

        // ---- the selection's bar, over the foot of the grid ----
        selCount.FontWeight = FontWeights.Bold;
        selCount.VerticalAlignment = VerticalAlignment.Center;
        selCount.TextWrapping = TextWrapping.Wrap;
        var clear = Build.Button(T["common.clearSelection"], () => ClearSelection());
        var restore = Build.Button(T["grid.restoreSelected"], () => RestoreSelected(), "BtnPrimary");
        clear.Margin = new Thickness(12, 0, 8, 0);
        var barButtons = Build.Stack(Orientation.Horizontal, clear, restore);
        var barRow = new DockPanel();
        DockPanel.SetDock(barButtons, Dock.Right);
        barRow.Children.Add(barButtons);
        barRow.Children.Add(selCount);
        bar = new Border
        {
            Child = barRow, CornerRadius = new CornerRadius(20), Padding = new Thickness(24, 12, 12, 12),
            VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(40, 0, 50, 16), Visibility = Visibility.Collapsed,
            Effect = barShadow, BorderThickness = new Thickness(1),
        };
        bar.SetResourceReference(Border.BackgroundProperty, "Card");
        bar.SetResourceReference(Border.BorderBrushProperty, "Divider");

        grid.ItemsSource = rows;
        grid.Prepare = Prepare;
        grid.Release = Release;
        grid.PreviewKeyDown += OnKeys;
        sticky = new Border
        {
            Child = stickyText, Visibility = Visibility.Collapsed, VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(40, 0, 50, 0), Padding = new Thickness(0, 12, 0, 8),
        };
        // Over the grid, the wheel still moves it.
        sticky.MouseWheel += (_, e) =>
        {
            grid.Scroller?.ScrollToVerticalOffset(grid.Scroller.VerticalOffset - e.Delta);
            e.Handled = true;
        };
        stickyText.FontSize = 17;
        stickyText.FontWeight = FontWeights.Bold;
        stickyText.TextTrimming = TextTrimming.CharacterEllipsis;
        stickyText.SetResourceReference(TextBlock.ForegroundProperty, "Text");
        sticky.SetResourceReference(Border.BackgroundProperty, "Bg");
        var root = new Grid();
        root.Children.Add(grid);
        root.Children.Add(sticky);
        root.Children.Add(bar);
        Content = root;

        // Not in the middle of the layout that changed the size: the rows are laid out anew after it.
        SizeChanged += (_, _) =>
        {
            if (fitPending) return;
            fitPending = true;
            Dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
            {
                fitPending = false;
                Fit();
            });
        };
        Loaded += (_, _) =>
        {
            Theme.Changed += Shade;
            Shade();
            thumbs.Use(session, (uid) => live.TryGetValue(uid, out var t) ? t : null);
            if (grid.Scroller is { } s)
            {
                s.ScrollChanged -= OnScrolled;
                s.ScrollChanged += OnScrolled;
            }
            // As many columns as the width has room for, before the grid is first seen.
            Fit();
        };
        Unloaded += (_, _) => Theme.Changed -= Shade;

        // Before the first rows are made: they ask for their thumbnails as they are.
        thumbs.Use(session, (uid) => live.TryGetValue(uid, out var t) ? t : null);
        Render(false);
        while (shown < (saved?.Shown ?? 0) && shown < list.Count) ShowMore();
        if (saved is { Scroll: > 0 } st)
        {
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () => grid.Scroller?.ScrollToVerticalOffset(st.Scroll));
        }
    }

    static void Add(WrapPanel w, UIElement e)
    {
        if (e is FrameworkElement fe) fe.Margin = new Thickness(0, 0, 16, 8);
        w.Children.Add(e);
    }

    /// <summary>A list with its name before it, as the page's toolbar has them.</summary>
    static FrameworkElement Labeled(string label, ComboBox box)
    {
        var t = Build.Text(label, "Muted");
        t.FontWeight = FontWeights.SemiBold;
        t.VerticalAlignment = VerticalAlignment.Center;
        t.Margin = new Thickness(0, 0, 8, 0);
        box.MinWidth = 160;
        var s = Build.Stack(Orientation.Horizontal, t, box);
        s.VerticalAlignment = VerticalAlignment.Center;
        return s;
    }

    void Shade()
    {
        barShadow.Color = Application.Current.TryFindResource("ShadowColor") is Color c ? c : Colors.Black;
        barShadow.Opacity = Application.Current.TryFindResource("ShadowOpacity") is double o ? o : 0.4;
    }

    List<JsonElement> PerSource() => job.Said("perSource") is { ValueKind: JsonValueKind.Array } p ? p.EnumerateArray().ToList() : [];

    static string Str(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    static long Num(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? (long)v.GetDouble() : 0;

    public State Save() => new(smaller, hideTiny, source, allDates, allPlaces, shown, selected.Keys.ToList(), grid.Scroller?.VerticalOffset ?? 0);

    public Job Job => job;

    // ---- drawing -------------------------------------------------------------------------------

    /// <summary>The copies the choices keep, drawn anew from the top; `say` tells assistive technology how many, after a choice.</summary>
    void Render(bool say)
    {
        var choices = new MediaData.Choices(smaller, hideTiny, source, allDates, allPlaces, r.From, r.To, r.Where);
        var f = MediaData.Filter(items, choices);
        // Tiny pictures are hidden at first; when nothing else would show, they are shown after all.
        if (f.Kept.Count == 0 && f.Hidden.Tiny > 0 && hideTiny)
        {
            hideTiny = false;
            quiet = true;
            tiny.IsOn = false;
            quiet = false;
            f = MediaData.Filter(items, choices with { HideTiny = false });
        }
        list = f.Kept;
        inList.Clear();
        foreach (var c in list) inList.TryAdd(c.Uid, c);
        // What a filter hides is no longer selected: nothing is restored that is not in sight.
        foreach (var uid in selected.Keys.Where((u) => !inList.ContainsKey(u)).ToList()) selected.Remove(uid);
        UpdateBar(false);
        months = MediaData.MonthCounts(list);
        var n = MediaData.Counts(list);
        summary.Text = list.Count > 0
            ? string.Join(" · ", new[]
            {
                T.Get("grid.count.photos", ("count", n.Photos)), T.Get("grid.count.videos", ("count", n.Videos)),
                n.Smaller > 0 ? T.Get("grid.count.smaller", ("count", n.Smaller)) : null,
            }.OfType<string>())
            : T["results.noMatch"];
        if (say) Announce.Say(summary.Text);
        ShowHidden(f.Kept, f.Hidden);
        RenderJump();
        gen++;
        groups.Clear();
        groupOf.Clear();
        focus = null;
        shown = 0;
        ShowMore();
    }

    int? MonthCount(string? month)
    {
        foreach (var m in months) if (m.Month == month) return m.Count;
        return null;
    }

    void ShowHidden(List<Copy> kept, MediaData.Hidden hd)
    {
        hiddenNote.Children.Clear();
        hiddenNote.Margin = new Thickness(0);
        int total = hd.Total;
        if (kept.Count == 0 && total > 0)
        {
            var actions = StatePage.Actions(
                hd.Smaller > 0 ? Build.Button(T.Get("grid.showSmaller", ("count", hd.Smaller)), () => size.Value = "smaller") : null,
                hd.OutsideDates > 0 ? Build.Button(T["results.allDates"], () => dates.IsOn = true) : null,
                hd.Elsewhere > 0 ? Build.Button(T.Get("results.allPlaces", ("folder", r.Where)), () => folderSwitch.IsOn = true) : null,
                hd.Tiny > 0 ? Build.Button(T.Get("grid.showTiny", ("count", hd.Tiny)), () => tiny.IsOn = false) : null,
                hd.Source > 0 ? Build.Button(T["grid.filter.allSources"], () =>
                {
                    quiet = true;
                    sourceSel.SelectedValue = "";
                    quiet = false;
                    source = "";
                    Render(true);
                }) : null);
            actions.Margin = new Thickness(0, 8, 0, 0);
            hiddenNote.Children.Add(Note(Build.Callout("info", null, Build.Text(T.Get("results.allHidden", ("count", total))), actions)));
            hiddenNote.Margin = new Thickness(0, 0, 0, 16);
            return;
        }
        var said = new List<string>();
        if (hd.Smaller > 0) said.Add(T.Get("grid.hidden.smaller", ("count", hd.Smaller)));
        if (hd.OutsideDates > 0) said.Add(T.Get("grid.hidden.dates", ("count", hd.OutsideDates)));
        if (hd.Elsewhere > 0) said.Add(T.Get("grid.hidden.elsewhere", ("count", hd.Elsewhere)));
        if (hd.Tiny > 0) said.Add(T.Get("grid.hidden.tiny", ("count", hd.Tiny)));
        if (said.Count > 0) hiddenNote.Children.Add(Build.Text(T.Get("grid.hidden", ("list", Formats.List(said))), "Hint").Margin(0, 0, 0, 8));
        if (MonthCount(null) is { } undated)
        {
            var show = Build.Button(T["grid.showUndated"], () => JumpTo(null));
            show.Margin = new Thickness(0, 8, 0, 0);
            hiddenNote.Children.Add(Note(Build.Callout("info", null, Build.Text(T.Get("grid.undatedNote", ("count", undated))), show)));
        }
        var all = MediaData.Counts(items);
        if (all.Videos == 0 && r.Types.Contains("video")) hiddenNote.Children.Add(Note(Build.Callout("info", null, Build.Text(T["grid.noVideos"]))));
        if (hiddenNote.Children.Count > 0) hiddenNote.Margin = new Thickness(0, 0, 0, 16);
    }

    static Border Note(Border callout)
    {
        callout.Margin = new Thickness(0, 0, 0, 8);
        return callout;
    }

    void RenderJump()
    {
        var choices = new List<Build.Choice> { new("", T["grid.jumpPick"]) };
        foreach (var m in months)
        {
            var named = m.Month is { } ym ? Formats.Month(ym) : T["grid.noDate"];
            choices.Add(new Build.Choice(m.Month ?? "none", T.Get("grid.month", ("month", named), ("count", m.Count))));
        }
        quiet = true;
        jump.ItemsSource = choices;
        jump.SelectedValue = "";
        quiet = false;
    }

    void Jumped()
    {
        if (quiet || jump.SelectedValue is not string v || v.Length == 0) return;
        JumpTo(v == "none" ? null : v);
    }

    /// <summary>Shows the next tiles: a page at a time, as the end of the grid comes near or its button is used.</summary>
    void ShowMore()
    {
        foreach (var c in list.Skip(shown).Take(MediaData.GridPage))
        {
            var month = MediaData.MonthOf(c);
            var key = month ?? "none";
            if (!groupOf.TryGetValue(key, out var g))
            {
                groupOf[key] = g = new Group(key, month);
                groups.Add(g);
            }
            g.Tiles.Add(c);
        }
        shown = Math.Min(list.Count, shown + MediaData.GridPage);
        int left = list.Count - shown;
        moreButton.Content = T.Get("results.showMore", ("count", Math.Min(MediaData.GridPage, Math.Max(0, left))));
        Layout();
        if (focus is null && order.Count > 0) SetFocus(order[0].Uid, false);
    }

    /// <summary>The rows the shown tiles make at this many columns, put in the list as the least change from what it held.</summary>
    void Layout()
    {
        order = groups.SelectMany((g) => g.Tiles).ToList();
        place.Clear();
        for (int i = 0; i < order.Count; i++) place[order[i].Uid] = i;
        rowsOf.Clear();
        var want = new List<object> { header };
        foreach (var g in groups)
        {
            want.Add(new MonthItem(gen, g.Key, g.Month));
            for (int i = 0, k = 0; i < g.Tiles.Count; i += cols, k++)
            {
                want.Add(new RowItem(gen, g.Key, k, Math.Min(cols, g.Tiles.Count - i), cols));
                rowsOf.Add((g, k));
            }
        }
        if (list.Count > shown) want.Add(moreRow);
        want.Add(bottom);
        Sync(want);
    }

    static string KeyOf(object o) => o switch
    {
        MonthItem m => "m:" + m.Key,
        RowItem r => $"r:{r.Key}:{r.Index}",
        _ => "e:" + o.GetHashCode(),
    };

    void Sync(List<object> want)
    {
        var keys = want.Select(KeyOf).ToHashSet();
        for (int i = 0; i < want.Count; i++)
        {
            var k = KeyOf(want[i]);
            if (i < rows.Count && KeyOf(rows[i]) == k)
            {
                if (!Equals(rows[i], want[i])) rows[i] = want[i];
                continue;
            }
            if (i < rows.Count && !keys.Contains(KeyOf(rows[i])))
            {
                rows.RemoveAt(i);
                i--;
                continue;
            }
            int later = -1;
            for (int j = i + 1; j < rows.Count; j++)
            {
                if (KeyOf(rows[j]) == k)
                {
                    later = j;
                    break;
                }
            }
            if (later >= 0)
            {
                rows.Move(later, i);
                if (!Equals(rows[i], want[i])) rows[i] = want[i];
            }
            else rows.Insert(i, want[i]);
        }
        while (rows.Count > want.Count) rows.RemoveAt(rows.Count - 1);
    }

    /// <summary>Columns follow the width, 150 pixels a tile at the least; the tile in focus keeps it.</summary>
    void Fit()
    {
        double width = ActualWidth - 80 - 10;
        if (width <= 0) return;
        int n = Math.Max(1, (int)Math.Floor((width + TileRowPanel.Gap) / (150 + TileRowPanel.Gap)));
        if (n == cols && drawn) return;
        drawn = true;
        bool had = Keyboard.FocusedElement is Tile t && live.ContainsValue(t);
        cols = n;
        Layout();
        if (had && focus is not null) Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () => SetFocus(focus, true));
    }

    /// <summary>A month's heading as the grid says it: "September 2026 (6)"; "No date" for the undated.</summary>
    string MonthTitle(string? month)
    {
        var named = month is { } ym ? Formats.Month(ym) : T["grid.noDate"];
        return MonthCount(month) is { } n ? T.Get("grid.month", ("month", named), ("count", n)) : named;
    }

    /// <summary>
    /// The heading of the month at the top of the grid, held there while its tiles scroll under
    /// it, as the page's sticky .month-title is: drawn over the grid, its words for the eye only,
    /// since the month's own heading is the one assistive technology reads.
    /// </summary>
    void Stick()
    {
        string? key = null;
        if (grid.Rows is { } panel && grid.Scroller is { } s)
        {
            foreach (UIElement child in panel.Children)
            {
                if (child is not FrameworkElement el || !el.IsVisible) continue;
                double y = el.TranslatePoint(new Point(0, 0), s).Y;
                if (y + el.ActualHeight <= 0) continue;
                var item = grid.ItemContainerGenerator.ItemFromContainer(el);
                if (item is RowItem ri) key = ri.Key;
                else if (item is MonthItem m && y < 0) key = m.Key;
                break;
            }
        }
        if (key is not null && groupOf.TryGetValue(key, out var g))
        {
            stickyText.Text = MonthTitle(g.Month);
            sticky.Visibility = Visibility.Visible;
        }
        else sticky.Visibility = Visibility.Collapsed;
    }

    void OnScrolled(object sender, ScrollChangedEventArgs e)
    {
        Stick();
        // More tiles as the end comes near, as the page's does 800 pixels before it: once the
        // layout that said so is done, since the rows are not to change in the middle of one.
        if (morePending || list.Count <= shown || e.ExtentHeight - (e.VerticalOffset + e.ViewportHeight) >= 800) return;
        morePending = true;
        Dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            morePending = false;
            if (list.Count > shown) ShowMore();
        });
    }

    // ---- rows as they come into sight ------------------------------------------------------------

    void Prepare(RowHost host, object item)
    {
        host.Margin = new Thickness(40, 0, 40, 0);
        switch (item)
        {
            case MonthItem m:
                {
                    var title = Build.Heading(MonthTitle(m.Month), 2);
                    title.FontSize = 17;
                    title.Margin = new Thickness(0, 12, 0, 8);
                    host.Child = Build.Stack(title, m.Month is null ? Build.Text(T["grid.noDate.body"], "Hint").Margin(0, 0, 0, 12) : null);
                    break;
                }
            case RowItem ri when groupOf.TryGetValue(ri.Key, out var g) && ri.Gen == gen:
                {
                    var panel = new TileRowPanel { Columns = ri.Cols };
                    int start = ri.Index * ri.Cols;
                    for (int i = start; i < Math.Min(g.Tiles.Count, start + ri.Count); i++)
                    {
                        var c = g.Tiles[i];
                        var tile = Rent();
                        tile.Bind(c, selected.ContainsKey(c.Uid));
                        KeyboardNavigation.SetIsTabStop(tile, c.Uid == focus);
                        live[c.Uid] = tile;
                        panel.Children.Add(tile);
                        thumbs.Want(tile);
                    }
                    host.Child = panel;
                    break;
                }
            default:
                host.Child = null;
                break;
        }
        TabSoon();
    }

    void Release(RowHost host, object item)
    {
        if (host.Child is TileRowPanel panel)
        {
            foreach (var tile in panel.Children.OfType<Tile>().ToList())
            {
                if (live.TryGetValue(tile.Copy.Uid, out var t) && t == tile) live.Remove(tile.Copy.Uid);
                panel.Children.Remove(tile);
                tile.ShowLoading();
                pool.Push(tile);
            }
        }
        host.Child = null;
        TabSoon();
    }

    Tile Rent()
    {
        if (pool.Count > 0) return pool.Pop();
        var t = new Tile(look);
        t.Clicked += OnTileClick;
        t.Invoked += (x) => OpenLightbox(list.IndexOf(x.Copy));
        t.SelectRequested += (x, on) =>
        {
            SetSelected(x.Copy.Uid, on);
            anchor = x.Copy.Uid;
            UpdateBar(true);
        };
        t.Focused += (x) => SetFocus(x.Copy.Uid, false);
        return t;
    }

    /// <summary>
    /// The tile Tab stops at: the one last in focus, or, while it is out of sight and not made, the
    /// first one in sight, so that Tab still enters the grid where the person is.
    /// </summary>
    void TabSoon()
    {
        if (tabPending) return;
        tabPending = true;
        Dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            tabPending = false;
            string? stop = focus is not null && live.ContainsKey(focus) ? focus
                : live.Keys.Where(place.ContainsKey).OrderBy((u) => place[u]).FirstOrDefault();
            foreach (var (uid, t) in live) KeyboardNavigation.SetIsTabStop(t, uid == stop);
        });
    }

    // ---- focus and the keys ----------------------------------------------------------------------

    void SetFocus(string uid, bool move)
    {
        if (focus is not null && focus != uid && live.TryGetValue(focus, out var was)) KeyboardNavigation.SetIsTabStop(was, false);
        focus = uid;
        if (!move)
        {
            if (live.TryGetValue(uid, out var t0)) KeyboardNavigation.SetIsTabStop(t0, true);
            TabSoon();
            return;
        }
        var t = Bring(uid);
        if (t is null) return;
        KeyboardNavigation.SetIsTabStop(t, true);
        t.Focus();
        Reveal(t);
        TabSoon();
    }

    /// <summary>
    /// A tile brought into sight clear of what lies over the grid: the month's heading held at the
    /// top, and the selection's bar at the foot.
    /// </summary>
    void Reveal(Tile t)
    {
        t.BringIntoView();
        if (grid.Scroller is not { } s) return;
        s.UpdateLayout();
        double top = t.TranslatePoint(new Point(0, 0), s).Y;
        double end = top + t.ActualHeight;
        double over = sticky.Visibility == Visibility.Visible ? sticky.ActualHeight : 0;
        double under = bar.Visibility == Visibility.Visible ? bar.ActualHeight + bar.Margin.Bottom : 0;
        if (top < over) s.ScrollToVerticalOffset(s.VerticalOffset - (over - top));
        else if (end > s.ViewportHeight - under) s.ScrollToVerticalOffset(s.VerticalOffset + (end - (s.ViewportHeight - under)));
    }

    /// <summary>The tile of a copy shown, made and brought into sight when it is not.</summary>
    Tile? Bring(string uid)
    {
        if (live.TryGetValue(uid, out var t)) return t;
        if (!place.TryGetValue(uid, out var at)) return null;
        var c = order[at];
        var key = MediaData.MonthOf(c) ?? "none";
        if (!groupOf.TryGetValue(key, out var g)) return null;
        int row = g.Tiles.IndexOf(c) / cols;
        int index = -1;
        for (int i = 0; i < rows.Count; i++)
        {
            if (rows[i] is RowItem ri && ri.Key == key && ri.Index == row)
            {
                index = i;
                break;
            }
        }
        grid.Realize(index);
        return live.TryGetValue(uid, out t) ? t : null;
    }

    (Group G, int Index, int Row) Locate(string uid)
    {
        var c = order[place[uid]];
        var g = groupOf[MediaData.MonthOf(c) ?? "none"];
        int i = g.Tiles.IndexOf(c);
        int row = rowsOf.FindIndex((x) => x.G == g && x.Row == i / cols);
        return (g, i, row);
    }

    Copy? RowTile(int row, int col)
    {
        if (row < 0 || row >= rowsOf.Count) return null;
        var (g, k) = rowsOf[row];
        int start = k * cols;
        int count = Math.Min(cols, g.Tiles.Count - start);
        return g.Tiles[start + Math.Max(0, Math.Min(col, count - 1))];
    }

    /// <summary>The tile a key moves to: along the row, or to the same column of the row above or below, across months (neighbour).</summary>
    Copy? Neighbour(string uid, Key key, bool ctrl, out bool known)
    {
        known = true;
        int at = place[uid];
        var (g, i, row) = Locate(uid);
        int col = i % cols;
        int rowStart = (i / cols) * cols;
        int rowEnd = Math.Min(g.Tiles.Count, rowStart + cols) - 1;
        switch (key)
        {
            case Key.Right: return at + 1 < order.Count ? order[at + 1] : null;
            case Key.Left: return at > 0 ? order[at - 1] : null;
            case Key.Down: return RowTile(row + 1, col);
            case Key.Up: return RowTile(row - 1, col);
            case Key.Home: return ctrl ? order[0] : g.Tiles[rowStart];
            case Key.End: return ctrl ? order[^1] : g.Tiles[rowEnd];
            case Key.PageDown: return RowTile(Math.Min(rowsOf.Count - 1, row + 3), 0);
            case Key.PageUp: return RowTile(Math.Max(0, row - 3), 0);
            default:
                known = false;
                return null;
        }
    }

    void OnKeys(object sender, KeyEventArgs e)
    {
        if (e.OriginalSource is not Tile t) return;
        var uid = t.Copy.Uid;
        var mods = Keyboard.Modifiers;
        bool ctrl = (mods & ModifierKeys.Control) != 0;
        bool shift = (mods & ModifierKeys.Shift) != 0;
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (key == Key.Space)
        {
            e.Handled = true;
            if (shift && anchor is not null) SelectRange(uid);
            else Toggle(uid);
            return;
        }
        if (key == Key.Enter)
        {
            e.Handled = true;
            OpenLightbox(list.IndexOf(t.Copy));
            return;
        }
        if (ctrl && key == Key.A)
        {
            e.Handled = true;
            foreach (var c in order) SetSelected(c.Uid, true);
            UpdateBar(true);
            return;
        }
        // Left and Right as they move on screen: right to left, the next tile lies to the left.
        if (FlowDirection == FlowDirection.RightToLeft && key is Key.Left or Key.Right) key = key == Key.Left ? Key.Right : Key.Left;
        if (!place.ContainsKey(uid)) return;
        var to = Neighbour(uid, key, ctrl, out bool known);
        if (!known) return;
        e.Handled = true;
        if (to is null) return;
        SetFocus(to.Uid, true);
        if (order.Count > 0 && to == order[^1] && list.Count > shown) ShowMore();
    }

    void OnTileClick(Tile t, bool onPick)
    {
        var uid = t.Copy.Uid;
        var mods = Keyboard.Modifiers;
        SetFocus(uid, true);
        if (onPick || (mods & ModifierKeys.Control) != 0) Toggle(uid);
        else if ((mods & ModifierKeys.Shift) != 0 && anchor is not null) SelectRange(uid);
        else OpenLightbox(list.IndexOf(t.Copy));
    }

    // ---- selection -------------------------------------------------------------------------------

    internal bool IsSelected(string uid) => selected.ContainsKey(uid);

    internal void SetSelected(string uid, bool on)
    {
        var c = inList.GetValueOrDefault(uid);
        if (on && c is not null) selected[uid] = c;
        else selected.Remove(uid);
        if (live.TryGetValue(uid, out var t)) t.SetSelected(on && c is not null);
    }

    void Toggle(string uid)
    {
        SetSelected(uid, !selected.ContainsKey(uid));
        anchor = uid;
        UpdateBar(true);
    }

    void SelectRange(string uid)
    {
        if (anchor is null || !place.TryGetValue(uid, out int b)) return;
        int a = place.TryGetValue(anchor, out var x) ? x : 0;
        if (a > b) (a, b) = (b, a);
        for (int i = Math.Max(0, a); i <= b; i++) SetSelected(order[i].Uid, true);
        UpdateBar(true);
    }

    void ClearSelection()
    {
        foreach (var uid in selected.Keys.ToList())
        {
            selected.Remove(uid);
            if (live.TryGetValue(uid, out var t)) t.SetSelected(false);
        }
        UpdateBar(true);
        if (focus is not null) SetFocus(focus, true);
    }

    internal void UpdateBar(bool say)
    {
        int n = selected.Count;
        long bytes = selected.Values.Sum((c) => c.Size ?? 0);
        var text = T.Get("grid.selected", ("count", n), ("size", Formats.Size(bytes)));
        bool changed = selCount.Text != text;
        selCount.Text = text;
        bar.Visibility = n > 0 ? Visibility.Visible : Visibility.Collapsed;
        bottom.Height = 96 + (n > 0 ? 80 : 0);
        if (say && changed && n > 0) Announce.Say(text);
    }

    void RestoreSelected()
    {
        if (selected.Count == 0 || Window.GetWindow(this) is not { } w) return;
        var dlg = new RestoreDialog(w, session, selected.Values.ToList());
        if (owner.ForShot) dlg.Show();
        else dlg.ShowDialog();
    }

    // ---- the lightbox, and the months -------------------------------------------------------------

    /// <summary>The copies the choices keep, in their order, for the lightbox's previous and next.</summary>
    public List<Copy> List => list;

    internal int Shown => shown;

    internal void ShowMoreIfNear(int i)
    {
        if (i >= shown - 3 && list.Count > shown) ShowMore();
    }

    internal void OpenLightbox(int index)
    {
        if (index < 0 || index >= list.Count || Window.GetWindow(this) is not { } w) return;
        var box = new Lightbox(w, this, session, look, index);
        Open = box;
        box.Closed += (_, _) =>
        {
            if (Open == box) Open = null;
            if (box.At < 0 || box.At >= list.Count) return;
            var uid = list[box.At].Uid;
            // Once it is gone, and not while the program itself is closing.
            Dispatcher.BeginInvoke(DispatcherPriority.Input, () =>
            {
                if (Dispatcher.HasShutdownStarted || !IsVisible || !place.ContainsKey(uid)) return;
                SetFocus(uid, true);
            });
        };
        if (owner.ForShot) box.Show();
        else box.ShowDialog();
    }

    /// <summary>Shows tiles until a month's are there, then moves to it: its heading at the top, the focus on its first tile.</summary>
    void JumpTo(string? month)
    {
        int at = list.FindIndex((c) => MediaData.MonthOf(c) == month);
        quiet = true;
        jump.SelectedValue = "";
        quiet = false;
        if (at < 0) return;
        while (shown <= at) ShowMore();
        var key = month ?? "none";
        if (!groupOf.TryGetValue(key, out var g)) return;
        int index = -1;
        for (int i = 0; i < rows.Count; i++)
        {
            if (rows[i] is MonthItem m && m.Key == key)
            {
                index = i;
                break;
            }
        }
        if (grid.Realize(index) is { } el && grid.Scroller is { } s)
        {
            var y = el.TransformToAncestor(s).Transform(new Point(0, 0)).Y;
            s.ScrollToVerticalOffset(s.VerticalOffset + y);
            s.UpdateLayout();
        }
        if (g.Tiles.Count > 0)
        {
            focus = g.Tiles[0].Uid;
            if (live.TryGetValue(focus, out var t))
            {
                KeyboardNavigation.SetIsTabStop(t, true);
                t.Focus();
            }
            else SetFocus(focus, true);
            TabSoon();
        }
    }

    // ---- for the pictures of the window -------------------------------------------------------

    /// <summary>The first copies shown, selected: as the person would with Space.</summary>
    public void SelectFirst(int n)
    {
        foreach (var c in order.Take(n)) SetSelected(c.Uid, true);
        anchor = order.Take(n).LastOrDefault()?.Uid;
        UpdateBar(false);
        if (anchor is not null) SetFocus(anchor, true);
    }

    public void ScrollBy(double y) => grid.Scroller?.ScrollToVerticalOffset((grid.Scroller?.VerticalOffset ?? 0) + y);

    public void Jump(string? month) => JumpTo(month);

    public void Choose(string what)
    {
        switch (what)
        {
            case "full": size.Value = "full"; break;
            case "smaller": size.Value = "smaller"; break;
            case "tiny": tiny.IsOn = !tiny.IsOn; break;
            case "dates": dates.IsOn = !dates.IsOn; break;
        }
    }

    public void OpenRestore() => RestoreSelected();

    /// <summary>A key pressed on the tile in focus, as the keyboard would.</summary>
    public void Press(Key key)
    {
        if (focus is null || Bring(focus) is not { } t || PresentationSource.FromVisual(t) is not { } source) return;
        t.RaiseEvent(new KeyEventArgs(Keyboard.PrimaryDevice, source, 0, key) { RoutedEvent = Keyboard.PreviewKeyDownEvent });
        // A window off the screen is never active, so the keyboard's focus is not drawn by itself: drawn here.
        foreach (var other in live.Values) other.Ring(false);
        if (focus is not null && live.TryGetValue(focus, out var now)) now.Ring(true);
    }

    public bool ThumbsBusy => thumbs.Busy;

    /// <summary>Dialogs open without holding the window, for a picture of them.</summary>
    internal bool ForShot => owner.ForShot;
}
