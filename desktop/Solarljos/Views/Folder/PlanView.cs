using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Folder;

/// <summary>What a plan's view held, to make it again in another language as it was (renderPlan's save).</summary>
public sealed record PlanState(string Filter, IReadOnlyCollection<string> Excluded, IReadOnlyCollection<string> LeftIn, IReadOnlyCollection<string> Opened);

/// <summary>
/// What a rebuild would write, as a tree to tick and untick (renderPlan in src/gui/ui/app.js).
/// Every file ever found below the folder is in it, also ones deleted long ago on purpose, so the
/// person decides. A file whose only copies are smaller ones or may be incomplete (the plan's
/// leftOut) is listed apart and left unticked: it is not the file, or may not be all of it. The
/// bar at the foot says what would be written and opens the dialog that asks where.
/// </summary>
sealed class PlanView : Part
{
    static Tr T => Tr.Instance;

    static readonly Dictionary<string, Func<PlanFile, bool>> Filters = new()
    {
        ["all"] = (_) => true,
        ["draft"] = (f) => f.Copy.Tier == "draft",
        ["inexact"] = (f) => f.Copy.Tier == "inexact",
        ["exists"] = (f) => f.Copy.State == "exists",
    };

    readonly FolderView owner;
    readonly string folder;
    readonly List<PlanFile> normal;
    readonly List<PlanFile> leftOut;
    readonly HashSet<string> excluded;
    readonly HashSet<string> leftIn;
    readonly HashSet<string> opened;
    string filter;
    PlanNode? top;
    readonly PlanTree? tree;
    readonly TextBlock barText = new() { FontWeight = FontWeights.Bold, FontSize = 15, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
    readonly Button write;
    readonly Border bar;
    readonly TranslateTransform lift = new();
    readonly ScrollViewer scroller;
    readonly DropShadowEffect shadow = new() { BlurRadius = 32, ShadowDepth = 8, Direction = 270 };

    public PlanView(FolderView owner, Job job, PlanState? saved)
    {
        this.owner = owner;
        Job = job;
        folder = Str(job.Said("folder")) ?? FolderRequest.FromEcho(job.Request).Folder;
        var all = job.Items.Where((i) => i is not null).Select((i) => PlanFile.From(i!.Value)).OfType<PlanFile>().ToList();
        normal = all.Where((f) => !f.LeftOut).ToList();
        leftOut = all.Where((f) => f.LeftOut).ToList();
        excluded = new HashSet<string>(saved?.Excluded ?? []);
        leftIn = new HashSet<string>(saved?.LeftIn ?? []);
        opened = new HashSet<string>(saved?.Opened ?? []);
        filter = saved is not null && Filters.ContainsKey(saved.Filter) ? saved.Filter : "all";
        Heading = T.Get("plan.title", ("count", all.Count), ("folder", folder));

        // What the files are taken from: how many of each quality, and of each kind of copy.
        var tierCounts = new Dictionary<string, int>();
        var kindCounts = new List<(string Kind, int Count)>();
        foreach (var f in normal)
        {
            var t = f.Copy.Tier;
            tierCounts[t] = tierCounts.GetValueOrDefault(t) + 1;
            int at = kindCounts.FindIndex((k) => k.Kind == f.Copy.Kind);
            if (at < 0) kindCounts.Add((f.Copy.Kind, 1));
            else kindCounts[at] = (f.Copy.Kind, kindCounts[at].Count + 1);
        }
        var tierLine = string.Join(" · ", new[] { ("exact", "plan.n.exact"), ("inexact", "plan.n.inexact"), ("draft", "plan.n.draft") }
            .Where((x) => tierCounts.GetValueOrDefault(x.Item1) > 0).Select((x) => T.Get(x.Item2, ("count", tierCounts[x.Item1]))));
        var kindLine = string.Join(" · ", kindCounts.Select((k, i) => (k, i)).OrderByDescending((x) => x.k.Count).ThenBy((x) => x.i)
            .Select((x) => T.Get("plan.fromKind", ("kind", Formats.KindLabel(x.k.Kind)), ("count", x.k.Count))));

        write = Build.Button("", OpenRebuild, "BtnPrimary");
        write.MinHeight = 44;

        // The head: what was found, from what, and a way to a new search in the form.
        var title = Build.Heading(Heading);
        var words = Build.Stack(title,
            tierLine.Length > 0 ? Summary(tierLine) : null,
            kindLine.Length > 0 ? Build.Text(T.Get("plan.from", ("list", kindLine)), "Muted").Margin(0, 8, 0, 0) : null);
        var again = Build.Button(T["common.newSearch"], () => owner.Go("", focus: true));
        again.VerticalAlignment = VerticalAlignment.Top;
        again.Margin = new Thickness(16, 2, 0, 0);
        var head = new DockPanel { Margin = new Thickness(0, 8, 0, 24) };
        DockPanel.SetDock(again, Dock.Right);
        head.Children.Add(again);
        head.Children.Add(words);

        var body = new StackPanel();
        body.Children.Add(head);
        body.Children.Add(Build.Text(T["plan.explain"], "Lead").Margin(0, 0, 0, 12));
        body.Children.Add(Build.Callout("warn", null, Build.Text(T["plan.oldFiles"], "Body")).Margin(0, 0, 0, 16));
        body.Children.Add(StatePage.Notices(job));

        if (normal.Count > 0)
        {
            tree = new PlanTree((n) => !excluded.Contains(n.Rel), Toggle, Opened, FolderView.ShowPreview, T.Get("plan.treeLabel", ("folder", folder)));
            tree.PreviewMouseWheel += Wheel;
            body.Children.Add(Toolbar(tierCounts));
            body.Children.Add(Build.Text(T["plan.keys"], "Hint").Margin(0, 0, 0, 8));
            body.Children.Add(tree);
            BuildTree();
        }
        if (leftOut.Count > 0) body.Children.Add(LeftOutList());

        // The bar at the foot, which stays in sight at the bottom of the window as the page's sticky one does.
        var barRow = new DockPanel();
        DockPanel.SetDock(write, Dock.Right);
        write.Margin = new Thickness(12, 0, 0, 0);
        barRow.Children.Add(write);
        barRow.Children.Add(barText);
        bar = new Border
        {
            Child = barRow, CornerRadius = new CornerRadius(20), Padding = new Thickness(24, 12, 12, 12), Margin = new Thickness(0, 16, 0, 0),
            BorderThickness = new Thickness(1), RenderTransform = lift, Effect = shadow,
        };
        bar.SetResourceReference(Border.BackgroundProperty, "Card");
        bar.SetResourceReference(Border.BorderBrushProperty, "Divider");
        AutomationProperties.SetLiveSetting(barText, AutomationLiveSetting.Polite);
        body.Children.Add(bar);
        Shadow();
        Theme.Changed += Shadow;

        scroller = Build.Page(body);
        scroller.ScrollChanged += (_, e) =>
        {
            if (e.ViewportHeightChange != 0) Fit();
            Stick();
        };
        bar.SizeChanged += (_, _) =>
        {
            Fit();
            Stick();
        };
        El = scroller;
        Recount();
    }

    static string? Str(System.Text.Json.JsonElement? v) => v is { ValueKind: System.Text.Json.JsonValueKind.String } s ? s.GetString() : null;

    static TextBlock Summary(string text)
    {
        var t = Build.Text(text, "Muted");
        t.FontSize = 16;
        t.Margin = new Thickness(0, 8, 0, 0);
        return t;
    }

    void Shadow()
    {
        shadow.Color = Application.Current.TryFindResource("ShadowColor") is Color c ? c : Colors.Black;
        shadow.Opacity = Application.Current.TryFindResource("ShadowOpacity") is double o ? o * 0.6 : 0.3;
    }

    /// <summary>The bar where it lies, or, when that is below the window, 16 pixels above the window's bottom.</summary>
    void Stick()
    {
        if (!bar.IsLoaded || scroller.ViewportHeight <= 0) return;
        double natural = bar.TranslatePoint(new Point(0, 0), scroller).Y - lift.Y;
        double floor = scroller.ViewportHeight - 16 - bar.ActualHeight;
        lift.Y = Math.Min(0, floor - natural);
    }

    /// <summary>
    /// The tree no taller than the window shows above the bar, so that all of it can be in sight at
    /// once: past that its rows scroll inside it, which is what lets it make only the ones in sight.
    /// </summary>
    void Fit()
    {
        if (tree is null || scroller.ViewportHeight <= 0) return;
        tree.MaxHeight = Math.Max(240, scroller.ViewportHeight - bar.ActualHeight - 40);
    }

    /// <summary>
    /// The wheel over the tree: the page scrolls until the whole tree is in sight above the bar,
    /// then the tree's rows, then the page again past either end of them -- as the page goes on
    /// over a tree that has no more to show, where the tree's scroller would keep the wheel.
    /// </summary>
    void Wheel(object sender, MouseWheelEventArgs e)
    {
        if (tree?.Scroller is not { } inner || !tree.IsLoaded) return;
        bool down = e.Delta < 0;
        double top = tree.TranslatePoint(new Point(0, 0), scroller).Y;
        bool inSight = down ? top + tree.ActualHeight <= scroller.ViewportHeight - bar.ActualHeight - 16 + 1 : top >= -1;
        bool pageCan = down ? scroller.VerticalOffset < scroller.ScrollableHeight - 0.5 : scroller.VerticalOffset > 0.5;
        bool treeCan = down ? inner.VerticalOffset < inner.ScrollableHeight - 0.5 : inner.VerticalOffset > 0.5;
        if (treeCan && (inSight || !pageCan)) return;
        e.Handled = true;
        if (pageCan) scroller.RaiseEvent(new MouseWheelEventArgs(e.MouseDevice, e.Timestamp, e.Delta) { RoutedEvent = UIElement.MouseWheelEvent });
    }

    WrapPanel Toolbar(Dictionary<string, int> tierCounts)
    {
        var choices = new List<(string, string)> { ("all", T["plan.filter.all"]) };
        if (tierCounts.GetValueOrDefault("draft") > 0) choices.Add(("draft", T["plan.filter.draft"]));
        if (tierCounts.GetValueOrDefault("inexact") > 0) choices.Add(("inexact", T["plan.filter.inexact"]));
        if (normal.Any((f) => f.Copy.State == "exists")) choices.Add(("exists", T["plan.filter.exists"]));
        var label = Build.Text(T["plan.filter.label"], "Body");
        label.FontWeight = FontWeights.SemiBold;
        label.LineHeight = double.NaN;
        label.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
        label.VerticalAlignment = VerticalAlignment.Center;
        label.Margin = new Thickness(0, 0, 8, 0);
        var select = Build.Select(choices, filter, T["plan.filter.label"]);
        select.MinWidth = 160;
        select.MinHeight = 40;
        select.SetResourceReference(Control.BackgroundProperty, "Card");
        AutomationProperties.SetLabeledBy(select, label);
        select.SelectionChanged += (_, _) =>
        {
            if (select.SelectedValue is string v && v != filter)
            {
                filter = v;
                BuildTree();
            }
        };
        var expand = Bits.Small(T["common.expandAll"], () => ExpandAll(true));
        var collapse = Bits.Small(T["common.collapseAll"], () => ExpandAll(false));
        var bar = new WrapPanel { Margin = new Thickness(0, 0, 0, 16) };
        var pick = Build.Stack(Orientation.Horizontal, label, select);
        foreach (var e in new FrameworkElement[] { pick, expand, collapse })
        {
            e.Margin = new Thickness(0, 0, 16, 8);
            e.VerticalAlignment = VerticalAlignment.Center;
            bar.Children.Add(e);
        }
        return bar;
    }

    /// <summary>The tree of what the filter shows, its folders open as they were; all open for a filter.</summary>
    void BuildTree()
    {
        if (tree is null) return;
        top = PlanNode.Build(normal.Where(Filters[filter]), Paths.BaseName(folder) is { Length: > 0 } b ? b : folder);
        if (filter != "all") ExpandNodes(top, true);
        else Reopen(top);
        PlanNode.CountIncluded(top, (n) => !excluded.Contains(n.Rel));
        tree.Show(top);
    }

    void Reopen(PlanNode node)
    {
        if (!node.Dir) return;
        if (opened.Contains(node.Rel)) node.Expanded = true;
        foreach (var c in node.Children) Reopen(c);
    }

    void ExpandNodes(PlanNode node, bool on)
    {
        if (!node.Dir) return;
        node.Expanded = on || node.Parent is null;
        if (node.Parent is not null && on) opened.Add(node.Rel);
        else if (node.Parent is not null) opened.Remove(node.Rel);
        foreach (var c in node.Children) ExpandNodes(c, on);
    }

    void ExpandAll(bool on)
    {
        if (top is null || tree is null) return;
        ExpandNodes(top, on);
        tree.Show(top);
        tree.Dispatcher.BeginInvoke(() => tree.FocusTop(), System.Windows.Threading.DispatcherPriority.Loaded);
    }

    void Opened(PlanNode node, bool on)
    {
        if (on) opened.Add(node.Rel);
        else opened.Remove(node.Rel);
    }

    /// <summary>Ticks every file below, or unticks them when all of them are ticked (toggleCheck).</summary>
    void Toggle(PlanNode node)
    {
        bool on = node.State((n) => !excluded.Contains(n.Rel)) != ToggleState.On;
        void walk(PlanNode n)
        {
            if (n.Dir) foreach (var c in n.Children) walk(c);
            else if (on) excluded.Remove(n.Rel);
            else excluded.Add(n.Rel);
        }
        walk(node);
        Recount(announce: true);
        tree?.Refresh();
    }

    /// <summary>How many files are ticked, and their size, in the bar and on its button (recount).</summary>
    int Recount(bool announce = false)
    {
        if (top is not null) PlanNode.CountIncluded(top, (n) => !excluded.Contains(n.Rel));
        int n = 0;
        long bytes = 0;
        foreach (var f in normal)
        {
            if (excluded.Contains(f.Rel)) continue;
            n++;
            bytes += f.Copy.Size ?? 0;
        }
        foreach (var f in leftOut)
        {
            if (!leftIn.Contains(f.Rel)) continue;
            n++;
            bytes += f.Copy.Size ?? 0;
        }
        barText.Text = n > 0 ? T.Get("plan.selected", ("count", n), ("size", Formats.Size(bytes))) : T["plan.none"];
        write.Content = T.Get("plan.write", ("count", n));
        AutomationProperties.SetName(write, (string)write.Content);
        write.IsEnabled = n > 0;
        if (announce) Announce.Say(barText.Text);
        return n;
    }

    Border LeftOutList()
    {
        var list = new StackPanel { Margin = new Thickness(0, 12, 0, 0) };
        foreach (var f in leftOut)
        {
            var rel = f.Rel;
            var check = Build.Check(rel, leftIn.Contains(rel));
            if (check.Content is TextBlock words)
            {
                words.FontFamily = Bits.Mono;
                words.FontSize = 13;
                words.FlowDirection = FlowDirection.LeftToRight;
            }
            check.VerticalAlignment = VerticalAlignment.Center;
            check.Checked += (_, _) => { leftIn.Add(rel); Recount(announce: true); };
            check.Unchecked += (_, _) => { leftIn.Remove(rel); Recount(announce: true); };
            var size = Build.Text(Formats.Size(f.Copy.Size), "Muted");
            size.LineHeight = double.NaN;
            size.VerticalAlignment = VerticalAlignment.Center;
            size.Margin = new Thickness(8, 0, 0, 0);
            var meta = Build.Stack(Orientation.Horizontal, Build.TierBadge(f.Copy), size);
            meta.VerticalAlignment = VerticalAlignment.Center;
            // Joined by a space, as they stand side by side: not every language's comma or colon.
            AutomationProperties.SetHelpText(check, Formats.TierText(f.Copy) + " " + size.Text);
            Button? preview = null;
            if (FolderView.ShowPreview is { } show)
            {
                preview = Bits.Small(T["results.preview"], () => show(f.Copy, preview!));
                AutomationProperties.SetName(preview, T["results.preview"] + " " + rel);
            }
            var line = new WrapPanel();
            foreach (var e in new FrameworkElement?[] { check, meta, preview })
            {
                if (e is null) continue;
                e.Margin = new Thickness(0, 4, 12, 4);
                line.Children.Add(e);
            }
            var row = new Border { Child = line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(0, 6, 0, 6) };
            row.SetResourceReference(Border.BorderBrushProperty, "Divider");
            list.Children.Add(row);
        }
        var card = Bits.Panel(T.Get("plan.leftOut.title", ("count", leftOut.Count)), Build.Text(T["plan.leftOut.body"], "Hint"), list);
        card.Margin = new Thickness(0, 16, 0, 0);
        return card;
    }

    /// <summary>The dialog that asks where to write what is ticked, and then starts writing it.</summary>
    void OpenRebuild() => owner.OpenRebuild(Request(), modal: true);

    /// <summary>What a rebuild of what is ticked would write.</summary>
    public RebuildRequest Request()
    {
        var chosen = normal.Where((f) => !excluded.Contains(f.Rel)).Concat(leftOut.Where((f) => leftIn.Contains(f.Rel))).ToList();
        return new RebuildRequest(Job!, folder, Paths.BaseName(folder) is { Length: > 0 } b ? b : folder,
            chosen.Select((f) => f.Copy.Size).ToList(), chosen.Count,
            normal.Select((f) => f.Rel).Where(excluded.Contains).ToList(), leftIn.ToList(), leftIn.Count);
    }

    public override object? Save() => new PlanState(filter, excluded.ToList(), leftIn.ToList(), opened.ToList());

    public override void Teardown() => Theme.Changed -= Shadow;

    /// <summary>Back in sight: the bar where it now belongs, as the window may have changed size meanwhile.</summary>
    public override void OnShow() => Stick();

    // ---- for the pictures ------------------------------------------------------------------------

    /// <summary>Unticks the files of the path given inside the folder, a folder all below it, as a click on its box does.</summary>
    public void Untick(string rel)
    {
        if (top is null) return;
        var node = Find(top, rel);
        if (node is not null && node.State((n) => !excluded.Contains(n.Rel)) != ToggleState.Off) Toggle(node);
    }

    /// <summary>Ticks a file left out, as its box does.</summary>
    public void TickLeftOut(string rel)
    {
        foreach (var check in Descendants<CheckBox>(El)) if (check.Content is TextBlock t && t.Text == rel) check.IsChecked = true;
    }

    public void Open(string rel)
    {
        if (top is null || tree is null) return;
        if (Find(top, rel) is { Dir: true } node) tree.SetExpanded(node, true);
    }

    /// <summary>The focus on a row, its ring drawn as when the keyboard took it there.</summary>
    public void FocusRow(string rel)
    {
        if (top is null || tree is null || Find(top, rel) is not { } node) return;
        tree.FocusNode(node);
        if (node.Item is { } item) item.Ring = true;
    }

    /// <summary>Keys pressed in the tree, one after another, from the row the keyboard is on.</summary>
    public async Task PressAsync(IEnumerable<System.Windows.Input.Key> keys)
    {
        if (tree is null) return;
        foreach (var k in keys)
        {
            tree.Press(k);
            await Task.Delay(60);
        }
    }

    public void ScrollToEnd() => scroller.ScrollToEnd();

    static PlanNode? Find(PlanNode node, string rel)
    {
        if (node.Rel == rel) return node;
        foreach (var c in node.Children) if (Find(c, rel) is { } found) return found;
        return null;
    }

    static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject
    {
        int n = VisualTreeHelper.GetChildrenCount(root);
        for (int i = 0; i < n; i++)
        {
            var c = VisualTreeHelper.GetChild(root, i);
            if (c is T t) yield return t;
            foreach (var d in Descendants<T>(c)) yield return d;
        }
    }
}
