using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Find;

/// <summary>What the results held, for when they are made again in another language.</summary>
public sealed record ResultsState
{
    public string View { get; init; } = "files";
    public string Sort { get; init; } = "newest";
    public string Q { get; init; } = "";
    public bool? DeletedOnly { get; init; }
    public bool AllDates { get; init; }
    public bool AllPlaces { get; init; }
    public int Shown { get; init; }
    public HashSet<string> Open { get; init; } = new();
    public string? Preview { get; init; }
    public int PreviewTab { get; init; }
    public double Scroll { get; init; }
}

/// <summary>
/// What a search by name found, by file or as every copy (resultsView in app.js). The filters --
/// only what is gone now, the dates, the folder it was in -- work on what the program holds, and
/// say how many copies each hides, with a way to show them. A copy's preview opens beside the
/// list in a wide window, over it in a narrow one.
/// </summary>
public sealed class ResultsView : UserControl
{
    static Tr T => Tr.Instance;

    /// <summary>File groups or copies shown at a time.</summary>
    public const int PageSize = 50;
    /// <summary>The preview lies beside the list in a window this wide or more, over it below (the page's 1,100 pixels).</summary>
    const double Beside = 1100;

    readonly Session session;
    readonly Job job;
    readonly FindRequest r;
    readonly List<Copy> items;

    // What is chosen: the page's ctl.
    string view;
    string sort;
    string q;
    bool deletedOnly, allDates, allPlaces;
    readonly HashSet<string> open;
    List<FileGroup> groupRows = new();
    List<Copy> copyRows = new();
    int shown;
    bool narrow;

    readonly Grid root = new();
    readonly ScrollViewer scroller;
    readonly Border holder;
    readonly TextBlock heading;
    readonly TextBlock summary = Build.Text("", "Muted");
    readonly StackPanel list = new();
    readonly StackPanel hiddenNote = new();
    readonly Button more;
    readonly RadioButton viewFiles, viewList;
    readonly ComboBox sortBox;
    readonly TextBox filter;
    readonly (Build.SwitchRow Row, Run Count) deleted, dates, places;
    readonly DispatcherTimer filterTimer = new() { Interval = TimeSpan.FromMilliseconds(200) };
    readonly Labeled pane = new() { Visibility = Visibility.Collapsed, Kind = AutomationControlType.Pane };
    readonly ScrollViewer paneScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };
    Table? fullTable;
    PreviewPanel? preview;
    UIElement? opener;
    bool rendered;
    // The file each card of the list is for, or the copy each row of the table of every copy: to
    // find them again once they are drawn anew.
    readonly Dictionary<FrameworkElement, string> keyOf = new();
    // The preview's shadow over the list in a narrow window: the theme's, as the page's --shadow.
    readonly DropShadowEffect overShadow = new() { BlurRadius = 48, ShadowDepth = 8, Direction = 180 };

    public string Heading { get; }

    public PreviewPanel? Preview => preview;

    public ScrollViewer Scroller => scroller;

    public ResultsView(Session session, Job job, ResultsState? saved, Action newSearch)
    {
        this.session = session;
        this.job = job;
        r = FindRequest.Of(job);
        items = job.Copies().ToList();
        var s = saved ?? new ResultsState();
        view = s.View == "copies" ? "copies" : "files";
        sort = s.Sort;
        q = s.Q;
        deletedOnly = s.DeletedOnly ?? r.DeletedOnly;
        allDates = s.AllDates;
        allPlaces = s.AllPlaces;
        open = new HashSet<string>(s.Open);

        Heading = r.Name.Length > 0 ? T.Get("results.title.name", ("name", r.Name))
            : r.Containing.Length > 0 ? T.Get("results.title.containing", ("text", r.Containing))
            : T.Get("results.title.type", ("type", ProgressView.TypeWords(r.Types)));
        heading = Build.Heading(Heading);
        heading.Focusable = true;
        heading.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(heading, false);
        summary.FontSize = 16;
        summary.Margin = new Thickness(0, 8, 0, 0);
        AutomationProperties.SetLiveSetting(summary, AutomationLiveSetting.Polite);
        var newButton = Build.Button(T["common.newSearch"], newSearch);
        newButton.Margin = new Thickness(0, 2, 0, 0);
        var head = Arrangement.HeadRow(Build.Stack(heading, summary), newButton);
        head.Margin = new Thickness(0, 8, 0, 24);

        // ---- the toolbar: which view, the order, a filter, and the switches ----
        var segments = new StackPanel { Orientation = Orientation.Horizontal };
        var group = "view-" + Guid.NewGuid().ToString("N");
        RadioButton seg(string label, string value)
        {
            var b = new RadioButton { Content = label, GroupName = group, IsChecked = view == value, Margin = new Thickness(0) };
            b.SetResourceReference(StyleProperty, "FindSeg");
            AutomationProperties.SetName(b, label);
            b.Checked += (_, _) => SetView(value);
            return b;
        }
        viewFiles = seg(T["results.view.files"], "files");
        viewList = seg(T["results.view.list"], "copies");
        viewList.Margin = new Thickness(4, 0, 0, 0);
        segments.Children.Add(viewFiles);
        segments.Children.Add(viewList);
        var segBox = new Labeled { Child = segments, Kind = AutomationControlType.Group };
        segBox.SetResourceReference(StyleProperty, "FindSegments");
        AutomationProperties.SetName(segBox, T["results.view.label"]);

        sortBox = Build.Select([
            ("newest", T["results.sort.newest"]), ("oldest", T["results.sort.oldest"]),
            ("name", T["results.sort.name"]), ("size", T["results.sort.size"]),
        ], sort, T["results.sort.label"]);
        sortBox.MinWidth = 168;
        sortBox.MinHeight = 40;
        sortBox.SetResourceReference(BackgroundProperty, "Card");
        sortBox.SelectionChanged += (_, _) =>
        {
            if (sortBox.SelectedValue is string v && v != sort)
            {
                sort = v;
                Render(true);
            }
        };
        filter = Build.Input(q);
        filter.Width = 224;
        filter.MinHeight = 40;
        filter.Padding = new Thickness(11, 7, 11, 7);
        filter.SetResourceReference(BackgroundProperty, "Card");
        AutomationProperties.SetName(filter, T["results.filter.label"]);
        filter.TextChanged += (_, _) =>
        {
            filterTimer.Stop();
            filterTimer.Start();
        };
        filterTimer.Tick += (_, _) =>
        {
            filterTimer.Stop();
            var now = filter.Text.Trim();
            if (now == q) return;
            q = now;
            Render(true);
        };
        deleted = Toggle(T["results.deletedOnly"], deletedOnly, (on) => deletedOnly = on);
        dates = Toggle(T["results.allDates"], allDates, (on) => allDates = on);
        places = Toggle(T.Get("results.allPlaces", ("folder", r.Where)), allPlaces, (on) => allPlaces = on);
        var toggles = new WrapPanel();
        toggles.Children.Add(deleted.Row.El.Margin(0, 0, 8, 4));
        if (r.Since is not null) toggles.Children.Add(dates.Row.El.Margin(0, 0, 8, 4));
        if (r.Where.Length > 0) toggles.Children.Add(places.Row.El.Margin(0, 0, 8, 4));
        var toolbar = new WrapPanel { Margin = new Thickness(0, 0, 0, 4) };
        toolbar.Children.Add(segBox.Margin(0, 0, 16, 12));
        toolbar.Children.Add(Labelled(T["results.sort.label"], sortBox).Margin(0, 0, 16, 12));
        toolbar.Children.Add(Labelled(T["results.filter.label"], filter).Margin(0, 0, 16, 12));
        toolbar.Children.Add(toggles.Margin(0, 0, 0, 12));

        hiddenNote.Margin = new Thickness(0, 0, 0, 16);
        more = Build.Button("", ShowMore);
        more.HorizontalAlignment = HorizontalAlignment.Center;
        more.Margin = new Thickness(0, 16, 0, 0);
        more.Visibility = Visibility.Collapsed;

        var main = Build.Stack(head, StatePage.Notices(job), toolbar, hiddenNote, list, more);
        holder = new Border { Child = main, MaxWidth = 1120, Margin = new Thickness(40, 40, 40, 96) };
        scroller = new ScrollViewer { Content = holder, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };

        // ---- the preview's place ----
        pane.Child = paneScroll;
        pane.SetResourceReference(Border.BackgroundProperty, "Card");
        paneScroll.Padding = new Thickness(24, 20, 24, 20);
        AutomationProperties.SetName(pane, T["preview.title"]);
        pane.KeyDown += (_, e) =>
        {
            if (e.Key != Key.Escape) return;
            e.Handled = true;
            ClosePreview();
        };
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        root.Children.Add(scroller);
        Grid.SetColumn(pane, 1);
        root.Children.Add(pane);
        Content = root;
        SizeChanged += (_, _) => Place();
        Loaded += (_, _) =>
        {
            Theme.Changed -= Shade;
            Theme.Changed += Shade;
            Shade();
        };
        Unloaded += (_, _) => Theme.Changed -= Shade;

        narrow = IsNarrow();
        Render(false);
        while (shown < s.Shown && shown < RowCount) ShowMore();
        if (s.Preview is { } uid && items.FirstOrDefault((c) => c.Uid == uid) is { } c0) OpenPreview(c0, null, s.PreviewTab, false);
        if (s.Scroll > 0)
        {
            void back(object? o, RoutedEventArgs e)
            {
                Loaded -= back;
                Dispatcher.BeginInvoke(() => scroller.ScrollToVerticalOffset(s.Scroll), DispatcherPriority.Loaded);
            }
            Loaded += back;
        }
    }

    public void FocusHeading() => heading.Focus();

    double WindowWidth => (Window.GetWindow(this) ?? Application.Current?.MainWindow)?.ActualWidth is > 0 and var w ? w : ActualWidth;

    bool IsNarrow() => WindowWidth < 700;

    /// <summary>A control with its name before it, small, bold and in the second colour, as the page's toolbar has them.</summary>
    static StackPanel Labelled(string label, FrameworkElement control)
    {
        var tb = Build.Text(label, "Muted");
        tb.FontWeight = FontWeights.SemiBold;
        tb.VerticalAlignment = VerticalAlignment.Center;
        tb.Margin = new Thickness(0, 0, 12, 0);
        tb.TextWrapping = TextWrapping.NoWrap;
        control.VerticalAlignment = VerticalAlignment.Center;
        return Build.Stack(Orientation.Horizontal, tb, control);
    }

    (Build.SwitchRow, Run) Toggle(string label, bool on, Action<bool> set)
    {
        var row = Build.Switch(label, on, null, compact: true);
        var count = new Run("") { FontWeight = FontWeights.Normal };
        count.SetResourceReference(TextElement.ForegroundProperty, "Text2");
        if (row.Words.Children[0] is TextBlock name) name.Inlines.Add(count);
        row.Changed += () =>
        {
            set(row.IsOn);
            Render(true);
        };
        return (row, count);
    }

    void SetView(string v)
    {
        if (view == v) return;
        view = v;
        Render(true);
    }

    int RowCount => view == "files" ? groupRows.Count : copyRows.Count;

    // ---- drawing the list ---------------------------------------------------------------------

    void Render(bool said)
    {
        var f = Arrangement.Filter(items, deletedOnly, r.Since, allDates, r.Where, allPlaces, q);
        var groups = Arrangement.GroupFiles(f.Kept);
        groupRows = view == "files" ? Arrangement.Sort(groups, sort) : [];
        copyRows = view == "copies" ? Arrangement.Sort(f.Kept, sort) : [];
        var files = T.Get("results.files", ("count", groups.Count));
        summary.Text = T.Get("results.summary", ("files", files), ("copies", T.Get("results.copies", ("count", f.Kept.Count))));
        ShowHidden(f);
        list.Children.Clear();
        keyOf.Clear();
        fullTable = null;
        if (f.Kept.Count == 0 && q.Length > 0) list.Children.Add(Build.Text(T["results.noMatch"], "Muted").Margin(0, 16, 0, 16));
        if (view == "copies" && copyRows.Count > 0)
        {
            fullTable = CopyTable([], full: true);
            list.Children.Add(Wrap(fullTable, "Card", 20));
        }
        shown = 0;
        ShowMore();
        // The summary is the page's status line: said when it changes.
        if (said && rendered) Announce.Say(summary.Text);
        rendered = true;
    }

    void ShowMore()
    {
        int next = Math.Min(PageSize, RowCount - shown);
        if (view == "files")
        {
            foreach (var g in groupRows.Skip(shown).Take(next)) list.Children.Add(FileCard(g).Margin(0, 0, 0, 12));
        }
        else if (fullTable is not null)
        {
            // The last row has no line below it; the one that was last now has.
            if (fullTable.Children.Count > 1 && fullTable.Children[^1] is TableRow was) was.LineBelow = true;
            foreach (var c in copyRows.Skip(shown).Take(next)) fullTable.Children.Add(CopyRow(c, true, false));
            if (fullTable.Children[^1] is TableRow lastRow && !lastRow.IsHeader) lastRow.LineBelow = false;
        }
        shown += next;
        int left = RowCount - shown;
        more.Visibility = left > 0 ? Visibility.Visible : Visibility.Collapsed;
        more.Content = T.Get("results.showMore", ("count", Math.Min(PageSize, Math.Max(0, left))));
    }

    void ShowHidden(Filtered f)
    {
        hiddenNote.Children.Clear();
        string say(int n) => n > 0 ? " " + T.Get("results.hiddenCount", ("count", n)) : "";
        deleted.Count.Text = deletedOnly ? say(f.NotDeleted) : "";
        dates.Count.Text = allDates ? "" : say(f.OutsideDates);
        places.Count.Text = allPlaces ? "" : say(f.Elsewhere);
        int total = f.NotDeleted + f.OutsideDates + f.Elsewhere;
        if (f.Kept.Count == 0 && total > 0 && q.Length == 0)
        {
            var buttons = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
            void add(int n, string label, Build.SwitchRow row)
            {
                if (n == 0) return;
                var b = Build.Button(label, () =>
                {
                    row.IsOn = !row.IsOn;
                    // This note goes as the copies it spoke of come back: the focus goes to the switch it turned.
                    row.Input.Focus();
                });
                b.Margin = new Thickness(0, 0, 8, 0);
                buttons.Children.Add(b);
            }
            add(f.NotDeleted, T["results.showNotDeleted"], deleted.Row);
            add(f.OutsideDates, T["results.allDates"], dates.Row);
            add(f.Elsewhere, T.Get("results.allPlaces", ("folder", r.Where)), places.Row);
            hiddenNote.Children.Add(Build.Callout("info", null, Build.Text(T.Get("results.allHidden", ("count", total)), "Body"), buttons).Margin(0, 0, 0, 8));
        }
        if (r.Since is not null && !allDates && f.Undated > 0)
            hiddenNote.Children.Add(Build.Text(T.Get("results.undatedKept", ("count", f.Undated)), "Hint"));
        hiddenNote.Visibility = hiddenNote.Children.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    // ---- a file -------------------------------------------------------------------------------

    static Button Small(string text, Action click, string style = "Btn")
    {
        var b = Build.Button(text, click, style);
        b.MinHeight = 32;
        b.MinWidth = 32;
        b.Padding = new Thickness(12, 4, 12, 4);
        b.FontSize = 14;
        Look.SetRadius(b, new CornerRadius(8));
        return b;
    }

    /// <summary>What can be done with a copy: look at it (its details, for a folder), and restore it.</summary>
    Panel Actions(Copy c, bool stacked)
    {
        Panel p = stacked ? new StackPanel() : new WrapPanel();
        void add(Button b)
        {
            b.Margin = stacked ? new Thickness(0, 0, 0, 4) : new Thickness(0, 0, 8, 4);
            if (stacked) b.HorizontalAlignment = HorizontalAlignment.Stretch;
            p.Children.Add(b);
        }
        Button? b1 = null;
        if (!c.IsDir && c.Tier != "gone") b1 = Small(T["results.preview"], () => OpenPreview(c, b1, 0, true));
        if (c.IsDir) b1 = Small(T["results.about"], () => OpenPreview(c, b1, 0, true));
        if (b1 is not null) add(b1);
        if (c.Tier != "gone")
        {
            Button? b2 = null;
            b2 = Small(T["results.restore"], () => Restore([c], b2));
            add(b2);
        }
        return p;
    }

    /// <summary>Where a file was, in words, when its folder, or its name too, is not known.</summary>
    static TextBlock WhereText(FileGroup g)
    {
        TextBlock tb;
        if (g.Folder is { } folder)
        {
            tb = Build.Text(folder, "Muted").AsPath();
        }
        else if (g.Name is not null) tb = Build.Text(T["results.folderUnknown"], "Muted");
        else tb = Build.Text(g.Best.Ext is { Length: > 0 } ext ? T.Get("results.nameUnknownLong", ("ext", Formats.FormatName(ext))) : T["results.nameUnknown"], "Muted");
        tb.FontSize = 14;
        tb.LineHeight = 20;
        tb.Margin = new Thickness(0, 2, 0, 0);
        return tb;
    }

    FrameworkElement FileCard(FileGroup g)
    {
        var best = g.Best;
        var others = g.Versions.Where((c) => c != best).ToList();
        var name = g.Name ?? T["results.nameUnknown"];

        var glyph = new Ui.Icon { Glyph = Arrangement.FileIcon(best), Width = 22, Height = 22 };
        glyph.SetResourceReference(Ui.Icon.ForegroundProperty, "TextOnTrack");
        var iconBox = new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(12), Child = glyph, VerticalAlignment = VerticalAlignment.Top };
        iconBox.SetResourceReference(Border.BackgroundProperty, "Track");
        var title = Build.Heading(name, 2);
        title.FontSize = 17;
        title.LineHeight = 25;
        var titleBox = Build.Stack(title, WhereText(g));
        var badges = new WrapPanel { HorizontalAlignment = narrow ? HorizontalAlignment.Left : HorizontalAlignment.Right, Margin = new Thickness(0, 2, 0, 0) };
        if (g.IsDir) badges.Children.Add(Build.Badge("Neutral", Formats.TierIcon("folder"), T["tier.folder"]).Margin(8, 0, 0, 4));
        badges.Children.Add(Build.StateBadge(g.State).Margin(8, 0, 0, 4));
        var headGrid = new Grid();
        headGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        headGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        headGrid.Children.Add(iconBox);
        titleBox.Margin = new Thickness(14, 0, 0, 0);
        Grid.SetColumn(titleBox, 1);
        headGrid.Children.Add(titleBox);
        if (narrow)
        {
            // In a narrow window the badges go below the name.
            headGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            headGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            badges.Margin = new Thickness(6, 4, 0, 0);
            Grid.SetRow(badges, 1);
            Grid.SetColumn(badges, 1);
        }
        else Grid.SetColumn(badges, 2);
        headGrid.Children.Add(badges);

        double indent = narrow ? 0 : 54;
        var bestLabel = Build.Text(T["results.best"], "Muted");
        bestLabel.VerticalAlignment = VerticalAlignment.Center;
        var found = Build.Text(Arrangement.FoundIn(best), "Body");
        found.FontWeight = FontWeights.Bold;
        found.VerticalAlignment = VerticalAlignment.Center;
        var bestLine = new WrapPanel();
        bestLine.Children.Add(bestLabel.Margin(0, 0, 8, 4));
        bestLine.Children.Add(Build.TierBadge(best).Margin(0, 0, 8, 4));
        bestLine.Children.Add(found.Margin(0, 0, 0, 4));
        var meta = Build.Text(Arrangement.MetaLine(best), "Muted");
        meta.Margin = new Thickness(0, 0, 0, 0);
        var acts = Actions(best, false);
        if (g.IsDir && best.Path is { Length: > 0 } folderPath)
        {
            Button? rb = null;
            rb = Small(T["results.rebuildFolder"], () => MainWindow.Navigate("folder/fill:" + folderPath), "BtnQuiet");
            rb.Margin = new Thickness(0, 0, 8, 4);
            rb.Tag = folderPath;
            acts.Children.Add(rb);
        }
        acts.Margin = new Thickness(0, 12, 0, 4);
        var bestBox = Build.Stack(bestLine, meta, acts);
        bestBox.Margin = new Thickness(indent, 8, 0, 0);
        var body = Build.Stack(headGrid, bestBox);

        if (g.Newer is { } newer)
        {
            var when = Formats.When(newer.When);
            var said = newer.Tier == "draft"
                ? T.Get("results.newerDraft", ("when", when))
                : T.Get("results.newerOther", ("when", when), ("tier", Formats.TierText(newer)));
            var na = Actions(newer, false);
            na.Margin = new Thickness(0, 8, 0, 0);
            body.Children.Add(Build.Callout("warn", null, Build.Text(said, "Body"), na).Margin(indent, 8, 0, 4));
        }
        if (others.Count > 0) body.Children.Add(Versions(others, g.Key, narrow ? 0 : 46));

        var card = new Labeled { Child = body, Padding = new Thickness(24, 20, 24, 16), CornerRadius = new CornerRadius(20), Kind = AutomationControlType.Group };
        card.SetResourceReference(Border.BackgroundProperty, "Card");
        AutomationProperties.SetName(card, name);
        keyOf[card] = g.Key;
        return card;
    }

    /// <summary>A file's other copies, under a line that opens them; which files have theirs open is kept.</summary>
    FrameworkElement Versions(List<Copy> others, string key, double indent)
    {
        var label = T.Get("results.versions", ("count", others.Count));
        var e = new Expander { Header = label, IsExpanded = open.Contains(key), Margin = new Thickness(indent, 0, 0, 0) };
        e.SetResourceReference(StyleProperty, "FindDisclosure");
        AutomationProperties.SetName(e, label);
        void fill()
        {
            if (e.Content is not null) return;
            e.Content = Wrap(CopyTable(others, full: false), "Raised", 14).Margin(0, 4, 0, 8);
        }
        if (e.IsExpanded) fill();
        e.Expanded += (_, _) =>
        {
            open.Add(key);
            fill();
        };
        e.Collapsed += (_, _) => open.Remove(key);
        return e;
    }

    /// <summary>A table in a box of its colour with round corners, which scrolls sideways where it is wider than the room.</summary>
    static Border Wrap(Table table, string colour, double radius)
    {
        var box = new Border { Child = table.InScroller(), CornerRadius = new CornerRadius(radius) };
        box.SetResourceReference(Border.BackgroundProperty, colour);
        // Its heading row's colour stays inside the round corners.
        box.SizeChanged += (_, ev) => box.Clip = new RectangleGeometry(new Rect(ev.NewSize), radius, radius);
        return box;
    }

    Table CopyTable(IEnumerable<Copy> copies, bool full)
    {
        var columns = new List<TableColumn>();
        if (full) columns.Add(new TableColumn());
        // The date on one line, as the page has it; in the table of every copy, on two where the
        // room is short, rather than that table wider than the window.
        columns.Add(full ? new TableColumn(Fill: true, Min: 96) : new TableColumn());
        columns.Add(new TableColumn(Fill: true, Min: 112));
        // In the table of every copy a long quality, "Smaller copy, 256 × 192", ends in an ellipsis
        // where the room is short, as the page's badge does, rather than push the actions out of sight.
        columns.Add(full ? new TableColumn(Fill: true, Min: 240, Floor: 112, Late: true) : new TableColumn());
        columns.Add(new TableColumn(End: true));
        if (full)
        {
            columns.Add(new TableColumn());
            columns.Add(new TableColumn(Fill: true, Min: 128));
        }
        columns.Add(new TableColumn());
        var table = full
            ? new Table(columns.ToArray()) { PadX = 8, EdgeStart = 20, EdgeEnd = 16 }
            : new Table(columns.ToArray());
        AutomationProperties.SetName(table, full ? T["results.view.list"] : T.Get("results.versions", ("count", copies.Count())));
        var heads = new List<FrameworkElement>();
        if (full) heads.Add(TableRow.Head(T["results.id"]));
        heads.Add(TableRow.Head(T["results.when"]));
        heads.Add(TableRow.Head(T["results.foundIn"]));
        heads.Add(TableRow.Head(T["results.quality"]));
        heads.Add(TableRow.Head(T["results.size"], end: true));
        if (full)
        {
            heads.Add(TableRow.Head(T["results.state"]));
            heads.Add(TableRow.Head(T["results.path"]));
        }
        // The actions' heading is for assistive technology only.
        var actionsHead = TableRow.Head(T["results.actions"]);
        actionsHead.Foreground = Brushes.Transparent;
        heads.Add(actionsHead);
        table.Children.Add(new TableRow(true, heads));
        var list_ = copies.ToList();
        for (int i = 0; i < list_.Count; i++) table.Children.Add(CopyRow(list_[i], full, i == list_.Count - 1 && !full));
        return table;
    }

    TableRow CopyRow(Copy c, bool full, bool lastRow)
    {
        var cells = new List<FrameworkElement>();
        if (full)
        {
            var id = TableRow.Cell(Arrangement.ShortId(c), wrap: false);
            id.FontFamily = new FontFamily("Cascadia Mono, Consolas");
            id.FlowDirection = FlowDirection.LeftToRight;
            cells.Add(id);
        }
        var when = Formats.When(c.When);
        // In Korean a date that wraps breaks between its words, as the table's own words do (Tr.KeepAll).
        cells.Add(TableRow.Cell(T.Code == "ko" ? Tr.KeepAll(when) : when, wrap: full));
        var found = Arrangement.FoundIn(c);
        cells.Add(TableRow.Cell(found));
        var tier = Build.TierBadge(c);
        tier.HorizontalAlignment = HorizontalAlignment.Left;
        cells.Add(tier);
        var size = c.IsDir ? "" : Formats.Size(c.Size);
        var sizeCell = TableRow.Cell(size, wrap: false);
        sizeCell.TextAlignment = TextAlignment.Right;
        cells.Add(sizeCell);
        if (full)
        {
            var state = Build.StateBadge(c.State);
            state.HorizontalAlignment = HorizontalAlignment.Left;
            cells.Add(state);
            cells.Add(c.Path is { Length: > 0 } p
                ? TableRow.Cell(p).AsPath()
                : TableRow.Cell(c.Name is { } n ? T.Get("results.nameOnly", ("name", n)) : T["results.nameUnknown"]));
        }
        cells.Add(Actions(c, full));
        // Not named for all its cells at once: a screen reader says each with its column's heading (TableCell).
        var row = new TableRow(false, cells, !lastRow);
        if (full) keyOf[row] = c.Uid;
        return row;
    }

    // ---- the preview --------------------------------------------------------------------------

    /// <summary>Opens a copy's preview, in place of the one open; the focus goes to its heading unless `focus` is false.</summary>
    public void OpenPreview(Copy copy, UIElement? from, int tab, bool focus)
    {
        opener = from;
        preview?.Destroy();
        preview = new PreviewPanel(session, copy, ClosePreview, tab, (c) => Restore([c], null));
        paneScroll.Content = preview;
        paneScroll.ScrollToTop();
        pane.Visibility = Visibility.Visible;
        Place();
        if (focus) Dispatcher.BeginInvoke(() => preview?.FocusHeading(), DispatcherPriority.Loaded);
    }

    public void ClosePreview()
    {
        preview?.Destroy();
        preview = null;
        paneScroll.Content = null;
        pane.Visibility = Visibility.Collapsed;
        Place();
        if (opener is { IsVisible: true } o) o.Focus();
        else FocusHeading();
    }

    /// <summary>
    /// Where the preview goes: beside the list in a wide window (its column at least 380 pixels,
    /// 42 hundredths of the room, and the whole at most 1,680 wide), over the list at the end of a
    /// narrow one, as wide as it can be up to 640 pixels.
    /// </summary>
    void Place()
    {
        bool wasNarrow = narrow;
        narrow = IsNarrow();
        if (wasNarrow != narrow && rendered)
        {
            // The cards are drawn again for the width, as many as were shown. The focus stays where it
            // was, on the same button of the same file, and the preview, closed, goes back to the
            // button that opened it as it is drawn now.
            var focus = SpotOf(Keyboard.FocusedElement as DependencyObject);
            var from = SpotOf(opener);
            int keep = shown;
            Render(false);
            while (shown < keep && shown < RowCount) ShowMore();
            if (focus is not null || from is not null)
                Dispatcher.BeginInvoke(() =>
                {
                    if (from is { } o) opener = AtSpot(o) ?? opener;
                    if (focus is { } f) AtSpot(f)?.Focus();
                }, DispatcherPriority.Loaded);
        }
        bool beside = WindowWidth >= Beside;
        double room = ActualWidth;
        if (preview is null)
        {
            Grid.SetColumnSpan(scroller, 2);
            holder.MaxWidth = 1120;
            holder.Margin = new Thickness(narrow ? 16 : 40, narrow ? 24 : 40, narrow ? 16 : 40, 96);
            root.MaxWidth = double.PositiveInfinity;
            return;
        }
        if (beside)
        {
            double layout = Math.Min(Math.Max(0, room - 80), 1680);
            double paneWidth = Math.Max(380, layout * 0.42);
            Grid.SetColumnSpan(scroller, 1);
            Grid.SetColumn(pane, 1);
            Grid.SetColumnSpan(pane, 1);
            holder.MaxWidth = double.PositiveInfinity;
            holder.Margin = new Thickness(40, 40, 24, 96);
            root.MaxWidth = 1680 + 80;
            pane.Width = paneWidth;
            pane.HorizontalAlignment = HorizontalAlignment.Stretch;
            pane.Margin = new Thickness(0, 40, 40, 40);
            pane.CornerRadius = new CornerRadius(20);
            pane.Effect = null;
        }
        else
        {
            Grid.SetColumnSpan(scroller, 2);
            holder.MaxWidth = 1120;
            holder.Margin = new Thickness(narrow ? 16 : 40, narrow ? 24 : 40, narrow ? 16 : 40, 96);
            root.MaxWidth = double.PositiveInfinity;
            Grid.SetColumn(pane, 0);
            Grid.SetColumnSpan(pane, 2);
            pane.Width = Math.Min(640, room);
            pane.HorizontalAlignment = HorizontalAlignment.Right;
            pane.Margin = new Thickness(0);
            pane.CornerRadius = new CornerRadius(0);
            pane.Effect = overShadow;
        }
    }

    void Shade()
    {
        overShadow.Color = Application.Current.TryFindResource("ShadowColor") is Color c ? c : Colors.Black;
        overShadow.Opacity = Application.Current.TryFindResource("ShadowOpacity") is double o ? o : 0.4;
    }

    /// <summary>Where an element is in the list: the file or copy of the card or row it is in, and which there of what takes the focus.</summary>
    (string Key, int At)? SpotOf(DependencyObject? d)
    {
        if (d is not UIElement e) return null;
        for (DependencyObject? at = e; at is not null && at != list; at = VisualTreeHelper.GetParent(at))
            if (at is FrameworkElement holder && keyOf.TryGetValue(holder, out var key))
                return (key, Focusables(holder).IndexOf(e));
        return null;
    }

    /// <summary>What is at a place in the list as it is drawn now, if anything is.</summary>
    UIElement? AtSpot((string Key, int At) spot)
    {
        var holder = keyOf.FirstOrDefault((kv) => kv.Value == spot.Key).Key;
        if (holder is null) return null;
        var all = Focusables(holder);
        return spot.At >= 0 && spot.At < all.Count ? all[spot.At] : null;
    }

    /// <summary>What takes the focus in an element and is in sight, in the order it is drawn in.</summary>
    static List<UIElement> Focusables(DependencyObject root)
    {
        var found = new List<UIElement>();
        void walk(DependencyObject d)
        {
            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(d); i++)
            {
                var child = VisualTreeHelper.GetChild(d, i);
                if (child is UIElement { Focusable: true, IsVisible: true } e) found.Add(e);
                walk(child);
            }
        }
        walk(root);
        return found;
    }

    // ---- restoring ----------------------------------------------------------------------------

    /// <summary>Asks where to put copies back, and does it; `modal` false only for the pictures of the window.</summary>
    public RestoreDialog? Restore(IReadOnlyList<Copy> copies, UIElement? from, bool modal = true)
    {
        var owner = Window.GetWindow(this);
        if (owner is null) return null;
        var dlg = new RestoreDialog(owner, session, copies);
        if (modal)
        {
            dlg.ShowDialog();
            if (from is { IsVisible: true }) from.Focus();
        }
        else dlg.Show();
        return dlg;
    }

    // ---- kept, and let go of ------------------------------------------------------------------

    public ResultsState Save() => new()
    {
        View = view, Sort = sort, Q = filter.Text.Trim(), DeletedOnly = deletedOnly, AllDates = allDates, AllPlaces = allPlaces,
        Shown = shown, Open = new HashSet<string>(open), Preview = preview?.Copy.Uid, PreviewTab = preview?.Tab ?? 0,
        Scroll = scroller.VerticalOffset,
    };

    /// <summary>Out of sight: no video goes on playing.</summary>
    public void Hide() => preview?.Pause();

    public void Destroy()
    {
        filterTimer.Stop();
        preview?.Destroy();
    }

    // For the pictures of the window.
    internal IEnumerable<FileGroup> Groups => groupRows.Count > 0 ? groupRows : Arrangement.GroupFiles(items);
    internal void Choose(string? v = null, string? q2 = null)
    {
        if (v is not null) (v == "copies" ? viewList : viewFiles).IsChecked = true;
        if (q2 is not null)
        {
            filter.Text = q2;
            q = q2;
            Render(true);
        }
    }
    internal void Flip(string which)
    {
        var row = which switch { "dates" => dates.Row, "places" => places.Row, _ => deleted.Row };
        row.IsOn = !row.IsOn;
    }
    internal void SortBy(string how) => sortBox.SelectedValue = how;
    internal void ShowMoreRows() => ShowMore();
    internal void OpenVersions(string key)
    {
        open.Add(key);
        Render(false);
    }
}
