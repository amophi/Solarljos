using System.Globalization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Folder;

/// <summary>One file of a folder's plan, as the engine sends it: its path inside the folder, its copy, and whether it is left out.</summary>
public sealed record PlanFile(string Rel, string[] Parts, bool LeftOut, Copy Copy)
{
    public static PlanFile? From(System.Text.Json.JsonElement it)
    {
        if (it.ValueKind != System.Text.Json.JsonValueKind.Object || !it.TryGetProperty("copy", out var c)) return null;
        string[] parts = it.TryGetProperty("rel", out var rel)
            ? rel.ValueKind == System.Text.Json.JsonValueKind.Array ? rel.EnumerateArray().Select((x) => x.ToString()).Where((x) => x.Length > 0).ToArray()
            : Paths.RelParts(rel.GetString() ?? "") : [];
        bool leftOut = it.TryGetProperty("leftOut", out var lo) && lo.ValueKind == System.Text.Json.JsonValueKind.True;
        return new PlanFile(string.Join('/', parts), parts, leftOut, Copy.From(c));
    }
}

/// <summary>
/// A folder or a file of the tree of a plan (buildTree in src/gui/ui/app.js). A path can be a file
/// in one copy and a folder in another -- a script "bin" that later became bin/cli.js -- so a
/// folder and a file of the same name live side by side, as rebuild writes them, and the file is
/// marked (Conflict): it comes back as "bin (recovered 2)".
/// </summary>
public sealed class PlanNode
{
    public string Name { get; init; } = "";
    public string Rel { get; init; } = "";
    public bool Dir { get; init; }
    public PlanNode? Parent { get; init; }
    public int Level { get; init; }
    public List<PlanNode> Children { get; } = new();
    public Dictionary<string, PlanNode> Dirs { get; } = new();
    public int Total { get; set; }
    public int Included { get; set; }
    public bool Expanded { get; set; }
    public PlanFile? File { get; init; }
    public bool Conflict { get; set; }
    /// <summary>Its row, while one is made for it: only the rows in sight are.</summary>
    internal PlanTreeItem? Item { get; set; }

    /// <summary>Its name, as UI Automation says a row that is not made yet.</summary>
    public override string ToString() => Name;

    static PlanNode Folder(string name, PlanNode? parent, string rel) =>
        new() { Name = name, Rel = rel, Dir = true, Parent = parent, Level = parent is null ? 1 : parent.Level + 1, Expanded = parent is null };

    /// <summary>The tree of these files below a folder of this name: folders first, then files, each by name.</summary>
    public static PlanNode Build(IEnumerable<PlanFile> files, string rootName)
    {
        var top = Folder(rootName, null, "");
        foreach (var file in files)
        {
            var parts = file.Parts;
            if (parts.Length == 0) continue;
            var node = top;
            for (int i = 0; i < parts.Length - 1; i++)
            {
                if (!node.Dirs.TryGetValue(parts[i], out var next))
                {
                    next = Folder(parts[i], node, string.Join('/', parts.Take(i + 1)));
                    node.Dirs[parts[i]] = next;
                    node.Children.Add(next);
                }
                node = next;
            }
            node.Children.Add(new PlanNode { Name = parts[^1], Rel = string.Join('/', parts), Dir = false, Parent = node, Level = node.Level + 1, File = file });
        }
        Finish(top);
        return top;
    }

    static int Finish(PlanNode node)
    {
        // Stable, as the page's sort is: folders first, then by name as the language orders names.
        var sorted = node.Children.Select((c, i) => (c, i)).OrderBy((x) => x.c.Dir ? 0 : 1).ThenBy((x) => x.c.Name, NameOrder.Instance).ThenBy((x) => x.i).Select((x) => x.c).ToList();
        node.Children.Clear();
        node.Children.AddRange(sorted);
        node.Total = 0;
        foreach (var c in node.Children)
        {
            if (c.Dir) node.Total += Finish(c);
            else
            {
                node.Total++;
                c.Conflict = node.Dirs.ContainsKey(c.Name);
            }
        }
        return node.Total;
    }

    /// <summary>How many files below are ticked, given what is left out; every folder's count is updated (countIncluded).</summary>
    public static int CountIncluded(PlanNode node, Func<PlanNode, bool> included)
    {
        if (!node.Dir) return included(node) ? 1 : 0;
        node.Included = 0;
        foreach (var c in node.Children) node.Included += CountIncluded(c, included);
        return node.Included;
    }

    /// <summary>Ticked, unticked, or, for a folder with some of its files ticked, both (checkState).</summary>
    public ToggleState State(Func<PlanNode, bool> included)
    {
        if (!Dir) return included(this) ? ToggleState.On : ToggleState.Off;
        if (Included == 0) return ToggleState.Off;
        return Included == Total ? ToggleState.On : ToggleState.Indeterminate;
    }

    /// <summary>Names as the page orders them: as the language does, numbers by their value, case and accents aside.</summary>
    sealed class NameOrder : IComparer<string>
    {
        public static readonly NameOrder Instance = new();
        static bool numeric = true;

        public int Compare(string? a, string? b)
        {
            var culture = Tr.Instance.Culture;
            if (numeric)
            {
                try
                {
                    return culture.CompareInfo.Compare(a, b, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace | CompareOptions.NumericOrdering);
                }
                catch (ArgumentException)
                {
                    numeric = false;
                }
            }
            return culture.CompareInfo.Compare(a, b, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace);
        }
    }
}

/// <summary>
/// The tree of a plan, to tick and untick, as the page's role=tree: arrow keys move, Right and Left
/// open and close a folder (the other way round right to left), Home and End go to the first and
/// the last row, Space ticks or unticks -- a folder all below it -- and Enter opens a folder or
/// shows a file. Its items are the plan's nodes, and only the rows in sight are made
/// (VirtualizingStackPanel), so that a plan of tens of thousands of files, every folder open, shows
/// at once; for that it scrolls on its own, as high as the page lets it be (MaxHeight).
/// </summary>
public sealed class PlanTree : TreeView
{
    readonly Func<PlanNode, bool> included;
    readonly Action<PlanNode> toggle;
    readonly Action<PlanNode, bool> expandedChanged;
    readonly Action<Copy, FrameworkElement>? preview;
    PlanNode? top;
    bool narrow;

    internal PlanTree(Func<PlanNode, bool> included, Action<PlanNode> toggle, Action<PlanNode, bool> expandedChanged, Action<Copy, FrameworkElement>? preview, string label)
    {
        this.included = included;
        this.toggle = toggle;
        this.expandedChanged = expandedChanged;
        this.preview = preview;
        AutomationProperties.SetName(this, label);
        Focusable = false;
        KeyboardNavigation.SetTabNavigation(this, KeyboardNavigationMode.Once);
        SizeChanged += (_, e) =>
        {
            bool now = e.NewSize.Width < 720;
            if (now == narrow) return;
            narrow = now;
            foreach (var item in Rows()) item.Layout.Narrow = narrow;
        };
    }

    internal bool Narrow => narrow;
    internal Func<PlanNode, bool> Included => included;

    /// <summary>The row made for the top folder, once it is.</summary>
    internal HashSet<PlanTreeItem> Kids { get; } = new();

    /// <summary>Where its rows scroll, inside it.</summary>
    internal ScrollViewer? Scroller => Template?.FindName("_tv_scrollviewer_", this) as ScrollViewer;

    protected override AutomationPeer OnCreateAutomationPeer() => new TreePeer(this);

    protected override DependencyObject GetContainerForItemOverride() => new PlanTreeItem(this);

    protected override void PrepareContainerForItemOverride(DependencyObject element, object item)
    {
        base.PrepareContainerForItemOverride(element, item);
        if (element is not PlanTreeItem row || item is not PlanNode node) return;
        Kids.Add(row);
        row.Bind(node);
    }

    protected override void ClearContainerForItemOverride(DependencyObject element, object item)
    {
        if (element is PlanTreeItem row && Kids.Remove(row)) row.Unbind();
        base.ClearContainerForItemOverride(element, item);
    }

    /// <summary>Shows this tree, as far as its folders are open.</summary>
    public void Show(PlanNode node)
    {
        top = node;
        Current = null;
        foreach (var row in Kids) row.Unbind();
        Kids.Clear();
        Items.Clear();
        Items.Add(node);
    }

    /// <summary>Every row made, in sight or not.</summary>
    IEnumerable<PlanTreeItem> Rows()
    {
        var stack = new Stack<PlanTreeItem>(Kids);
        while (stack.Count > 0)
        {
            var row = stack.Pop();
            yield return row;
            foreach (var kid in row.Kids) stack.Push(kid);
        }
    }

    /// <summary>
    /// Opens or closes a folder; the top one stays open (setExpanded). Its row, if one is made,
    /// follows (PlanTreeItem's IsExpanded is its node's), and its rows are made as they come into sight.
    /// </summary>
    internal void SetExpanded(PlanNode node, bool on)
    {
        if (!node.Dir || (node.Parent is null && !on)) return;
        node.Expanded = on;
        expandedChanged(node, on);
        if (node.Item is not { } item) return;
        item.CoerceValue(TreeViewItem.IsExpandedProperty);
        item.Refresh();
    }

    /// <summary>Opens a folder and every folder below it, as TreeView's own * does.</summary>
    void OpenAll(PlanNode node)
    {
        if (!node.Dir) return;
        SetExpanded(node, true);
        foreach (var c in node.Children) OpenAll(c);
    }

    /// <summary>Each row's box as it now stands: the rows made; one made later is made so.</summary>
    public void Refresh()
    {
        foreach (var row in Rows()) row.Refresh();
    }

    /// <summary>The rows in the order they show, as far as folders are open.</summary>
    List<PlanNode> Visible()
    {
        var list = new List<PlanNode>();
        void walk(PlanNode n)
        {
            list.Add(n);
            if (n.Dir && n.Expanded) foreach (var c in n.Children) walk(c);
        }
        if (top is not null) walk(top);
        return list;
    }

    /// <summary>
    /// A row that shows, made and brought into the tree's sight if it was not: only the rows in
    /// sight are made, so the one the keyboard goes to may not be yet. The folder above it is
    /// asked for it, as that folder's own panel makes its rows, and that folder of its own folder.
    /// </summary>
    PlanTreeItem? Realize(PlanNode node)
    {
        if (node.Item is { } made) return made;
        ItemsControl? owner = node.Parent is null ? this : Realize(node.Parent);
        if (owner is null or PlanTreeItem { IsExpanded: false }) return null;
        var panel = RowsPanel(owner);
        if (panel is null)
        {
            // A folder opened a moment ago has no panel until it is laid out.
            owner.UpdateLayout();
            panel = RowsPanel(owner);
        }
        panel?.BringIndexIntoViewPublic(node.Parent is null ? 0 : node.Parent.Children.IndexOf(node));
        return node.Item;
    }

    /// <summary>The panel that makes a folder's rows, or the tree's own, once there is one.</summary>
    static VirtualizingStackPanel? RowsPanel(ItemsControl owner)
    {
        owner.ApplyTemplate();
        if (owner.Template?.FindName(owner is PlanTree ? "Rows" : "ItemsHost", owner) is not ItemsPresenter presenter) return null;
        presenter.ApplyTemplate();
        if (VisualTreeHelper.GetChildrenCount(presenter) == 0 || VisualTreeHelper.GetChild(presenter, 0) is not VirtualizingStackPanel panel) return null;
        // Its rows' maker is set up when its children are first asked for.
        _ = panel.Children;
        return panel;
    }

    public void FocusNode(PlanNode? node)
    {
        if (node is null || Realize(node) is not { } item) return;
        Current = node;
        item.Focus();
        item.Row.BringIntoView();
    }

    /// <summary>The row the keyboard is on, or was last.</summary>
    internal PlanNode? Current { get; set; }

    /// <summary>For the pictures: a key pressed on the row the keyboard is on, as the keyboard sends it.</summary>
    internal void Press(Key key)
    {
        var node = Current ?? top;
        if (node is null || Realize(node) is not { } item || PresentationSource.FromVisual(item) is not { } source) return;
        item.RaiseEvent(new KeyEventArgs(Keyboard.PrimaryDevice, source, 0, key) { RoutedEvent = Keyboard.PreviewKeyDownEvent });
        if (Current?.Item is { } now) now.Ring = true;
        if (item != Current?.Item) item.Ring = false;
    }

    public void FocusTop() => FocusNode(top);

    internal void Toggle(PlanNode node) => toggle(node);

    internal void Open(PlanNode node, FrameworkElement from)
    {
        if (node.Dir) SetExpanded(node, !node.Expanded);
        else if (node.File is { } f) preview?.Invoke(f.Copy, from);
    }

    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        if (e.OriginalSource is not PlanTreeItem { Node: var node } item || item.Tree != this)
        {
            base.OnPreviewKeyDown(e);
            return;
        }
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (Keyboard.Modifiers is not (ModifierKeys.None or ModifierKeys.Shift))
        {
            base.OnPreviewKeyDown(e);
            return;
        }
        // Left and Right as they move on screen: right to left, a folder's inside lies to the left.
        if (FlowDirection == FlowDirection.RightToLeft) key = key == Key.Left ? Key.Right : key == Key.Right ? Key.Left : key;
        var list = Visible();
        int at = list.IndexOf(node);
        PlanNode? to = null;
        switch (key)
        {
            case Key.Down: to = at + 1 < list.Count ? list[at + 1] : null; break;
            case Key.Up: to = at > 0 ? list[at - 1] : null; break;
            case Key.Home: to = list.FirstOrDefault(); break;
            case Key.End: to = list.LastOrDefault(); break;
            case Key.Right:
                if (node.Dir && !node.Expanded) SetExpanded(node, true);
                else if (node.Dir) to = node.Children.FirstOrDefault();
                break;
            case Key.Left:
                if (node.Dir && node.Expanded && node.Parent is not null) SetExpanded(node, false);
                else to = node.Parent;
                break;
            case Key.Space:
                Toggle(node);
                break;
            case Key.Enter:
                Open(node, item);
                break;
            // TreeView's own: + opens a folder, * it and every folder below it, - closes it; the top folder stays open.
            case Key.Add:
            case Key.Subtract:
                if (node.Dir) SetExpanded(node, key == Key.Add);
                break;
            case Key.Multiply:
                OpenAll(node);
                break;
            default:
                base.OnPreviewKeyDown(e);
                return;
        }
        e.Handled = true;
        if (to is not null) FocusNode(to);
    }

    // ---- what assistive technology is told ------------------------------------------------------

    /// <summary>The tree's rows are told as tree items that are also ticked, unticked or partly (aria-checked).</summary>
    sealed class TreePeer(PlanTree owner) : TreeViewAutomationPeer(owner)
    {
        protected override ItemAutomationPeer CreateItemAutomationPeer(object item) => new RowPeer(item, this, null, owner);
    }

    /// <summary>A row as UI Automation knows it, made or not yet: ticked as its node is.</summary>
    internal sealed class RowPeer(object item, ItemsControlAutomationPeer parent, TreeViewDataItemAutomationPeer? parentRow, PlanTree tree)
        : TreeViewDataItemAutomationPeer(item, parent, parentRow), IToggleProvider
    {
        public override object GetPattern(PatternInterface p) =>
            p == PatternInterface.Toggle && Item is PlanNode ? this : base.GetPattern(p);

        public ToggleState ToggleState => Item is PlanNode node ? node.State(tree.Included) : ToggleState.Off;

        public void Toggle()
        {
            if (Item is PlanNode node) tree.Toggle(node);
        }
    }

    /// <summary>
    /// A row made, as UI Automation knows it: ticked as it is, and opened and closed as the
    /// keyboard does it, through the tree, so that its node follows -- not by setting IsExpanded,
    /// which is its node's (Narrator, Voice Access).
    /// </summary>
    internal sealed class ItemPeer(PlanTreeItem owner) : TreeViewItemAutomationPeer(owner), IToggleProvider, IExpandCollapseProvider
    {
        protected override ItemAutomationPeer CreateItemAutomationPeer(object item) =>
            new RowPeer(item, this, EventsSource as TreeViewDataItemAutomationPeer, owner.Tree);

        public override object GetPattern(PatternInterface p) => p == PatternInterface.Toggle ? this : base.GetPattern(p);

        public ToggleState ToggleState => owner.State;

        public void Toggle() => owner.Tree.Toggle(owner.Node);

        ExpandCollapseState IExpandCollapseProvider.ExpandCollapseState =>
            !owner.Node.Dir ? ExpandCollapseState.LeafNode : owner.IsExpanded ? ExpandCollapseState.Expanded : ExpandCollapseState.Collapsed;

        void IExpandCollapseProvider.Expand() => owner.Tree.SetExpanded(owner.Node, true);

        void IExpandCollapseProvider.Collapse() => owner.Tree.SetExpanded(owner.Node, false);
    }
}

/// <summary>
/// A row of the tree: the arrow that opens a folder, its box, its icon, its name, and how many
/// files a folder holds or, for a file, its best copy: when it is from, what kind, how good, its
/// size, and whether something is at its place now. An unticked name is struck through. A row is
/// made for a node as it comes into sight (Bind) and let go of when it goes (Unbind); a folder's
/// own rows are its node's children, made as they come into sight in turn.
/// </summary>
public sealed class PlanTreeItem : TreeViewItem
{
    static Tr T => Tr.Instance;

    static PlanTreeItem()
    {
        // Whether a row is open is its node's, whatever sets IsExpanded: the virtualizing panel
        // clears what was set on a row it has just made, and the top folder's is always open.
        // The tree opens and closes a node, and its row follows (SetExpanded).
        IsExpandedProperty.OverrideMetadata(typeof(PlanTreeItem), new FrameworkPropertyMetadata(false, null,
            (d, value) => d is PlanTreeItem { Node: { } node } ? node.Dir && node.Expanded : value));
    }

    public static readonly DependencyProperty RingProperty = DependencyProperty.Register(
        nameof(Ring), typeof(bool), typeof(PlanTreeItem), new PropertyMetadata(false));

    /// <summary>For the pictures, where no key is pressed: the ring is drawn wherever the focus is.</summary>
    internal static bool KeepRing { get; set; }

    /// <summary>The keyboard is on it: the ring is drawn round its row (the page's :focus-visible).</summary>
    public bool Ring { get => (bool)GetValue(RingProperty); set => SetValue(RingProperty, value); }

    internal PlanTree Tree { get; }
    /// <summary>Its node, from when it is made for one.</summary>
    internal PlanNode Node { get; private set; } = null!;
    internal RowPanel Layout { get; private set; } = null!;
    internal FrameworkElement Row => Layout;
    internal ToggleState State { get; private set; }
    /// <summary>The rows made for its folder's own files and folders.</summary>
    internal HashSet<PlanTreeItem> Kids { get; } = new();

    Border box = null!;
    Icon tick = null!;
    TextBlock name = null!;
    Border twisty = null!;
    readonly RotateTransform turn = new(0);

    internal PlanTreeItem(PlanTree tree) => Tree = tree;

    protected override DependencyObject GetContainerForItemOverride() => new PlanTreeItem(Tree);

    protected override void PrepareContainerForItemOverride(DependencyObject element, object item)
    {
        base.PrepareContainerForItemOverride(element, item);
        if (element is not PlanTreeItem row || item is not PlanNode node) return;
        Kids.Add(row);
        row.Bind(node);
    }

    protected override void ClearContainerForItemOverride(DependencyObject element, object item)
    {
        if (element is PlanTreeItem row && Kids.Remove(row)) row.Unbind();
        base.ClearContainerForItemOverride(element, item);
    }

    /// <summary>Makes it the row of a node: what it says, as it stands, and, for a folder, its own rows to make.</summary>
    internal void Bind(PlanNode node)
    {
        Node = node;
        node.Item = this;
        var level = node.Level - 1;
        Padding = new Thickness(6 + level * 24, 2, 10, 2);

        var chevron = new Icon { Glyph = "chevron", Width = 16, Height = 16, RenderTransformOrigin = new Point(0.5, 0.5), RenderTransform = turn };
        chevron.SetResourceReference(Icon.ForegroundProperty, "Text2");
        twisty = new Border { Width = 22, Height = 22, CornerRadius = new CornerRadius(6), Background = Brushes.Transparent, Child = node.Dir ? chevron : null };
        if (node.Dir)
        {
            twisty.Cursor = Cursors.Hand;
            twisty.MouseEnter += (_, _) => twisty.SetResourceReference(Border.BackgroundProperty, "Hover");
            twisty.MouseLeave += (_, _) => twisty.Background = Brushes.Transparent;
        }
        // A tick and a file's icon read the same either way; only the arrow turns round right to left (style.css).
        tick = new Icon { Width = 14, Height = 14, Thickness = 2.8, FlowDirection = FlowDirection.LeftToRight };
        tick.SetResourceReference(Icon.ForegroundProperty, "OnFill");
        box = new Border { Width = 20, Height = 20, CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(2), Child = tick, Cursor = Cursors.Hand, Margin = new Thickness(10, 0, 10, 0) };
        box.MouseEnter += (_, _) => { if (State == ToggleState.Off) box.SetResourceReference(Border.BorderBrushProperty, "Text"); };
        box.MouseLeave += (_, _) => Refresh();
        var copy = node.File?.Copy;
        var icon = new Icon { Glyph = node.Dir ? "folder" : FileIcon(copy), Width = 20, Height = 20, FlowDirection = FlowDirection.LeftToRight };
        icon.SetResourceReference(Icon.ForegroundProperty, "Text2");
        var lead = Build.Stack(Orientation.Horizontal, twisty, box, icon);
        lead.VerticalAlignment = VerticalAlignment.Center;

        name = new TextBlock { Text = node.Name, FontWeight = FontWeights.Bold, FontSize = 15, TextWrapping = TextWrapping.Wrap, Cursor = Cursors.Hand, FlowDirection = Bits.DirectionOf(node.Name) };
        FrameworkElement? extra;
        string help;
        if (node.Dir)
        {
            var count = Small(T.Get("plan.folderCount", ("count", node.Total)));
            extra = count;
            help = count.Text;
        }
        else
        {
            var c = copy!;
            var meta = new WrapPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var words = new List<string>();
            void add(FrameworkElement e, string said)
            {
                e.Margin = new Thickness(0, 2, 12, 2);
                e.VerticalAlignment = VerticalAlignment.Center;
                meta.Children.Add(e);
                words.Add(said);
            }
            var day = Formats.Day(c.When);
            var kind = Formats.KindLabel(c.Kind, c.KindLabel);
            var size = Formats.Size(c.Size);
            add(Small(day), day);
            add(Small(kind), kind);
            add(Build.TierBadge(c), Formats.TierText(c));
            add(Small(size), size);
            if (c.State == "exists") add(Build.Badge("Exists", null, T["plan.stillThere"]), T["plan.stillThere"]);
            if (meta.Children.Count > 0 && meta.Children[^1] is FrameworkElement last) last.Margin = new Thickness(0, 2, 0, 2);
            extra = meta;
            // Side by side as the row shows them: no comma, which is not every language's.
            help = string.Join(" ", words);
        }
        TextBlock? hint = null;
        if (node.Conflict)
        {
            hint = Build.Text(T["plan.conflict"], "Hint");
            hint.Margin = new Thickness(0, 0, 0, 4);
            help += " " + hint.Text;
        }
        Layout = new RowPanel(lead, name, extra, hint, atEnd: !node.Dir) { Narrow = Tree.Narrow };
        Header = Layout;
        AutomationProperties.SetName(this, node.Name);
        AutomationProperties.SetHelpText(this, help);
        // A folder's rows are its node's children, made when it is open and they come into sight.
        if (node.Dir) ItemsSource = node.Children;
        CoerceValue(IsExpandedProperty);
        Refresh();
    }

    /// <summary>No longer its node's row, nor the rows made inside it theirs (ClearContainerForItemOverride).</summary>
    internal void Unbind()
    {
        foreach (var kid in Kids) kid.Unbind();
        Kids.Clear();
        if (Node.Item == this) Node.Item = null;
    }

    static TextBlock Small(string text)
    {
        var t = Build.Text(text, "Muted");
        t.FontSize = 14;
        t.LineHeight = double.NaN;
        t.TextWrapping = TextWrapping.NoWrap;
        return t;
    }

    /// <summary>The icon of a kind of file, for the eye: a folder, a picture, a video, or a page (fileIcon).</summary>
    static string FileIcon(Copy? c)
    {
        if (c is { IsDir: true }) return "folder";
        return c?.Media switch { "image" => "photo", "video" => "video", _ => "file" };
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new PlanTree.ItemPeer(this);

    /// <summary>Its box, its name and its arrow as it now stands; a change of tick is told to assistive technology.</summary>
    internal void Refresh()
    {
        var was = State;
        State = Node.State(Tree.Included);
        bool on = State != ToggleState.Off;
        if (on) box.SetResourceReference(Border.BackgroundProperty, "Accent");
        else box.Background = Brushes.Transparent;
        box.SetResourceReference(Border.BorderBrushProperty, on ? "Accent" : "CheckLine");
        tick.Glyph = State == ToggleState.On ? "check" : State == ToggleState.Indeterminate ? "minus" : "";
        name.SetResourceReference(TextBlock.ForegroundProperty, on ? "Text" : "Text2");
        name.TextDecorations = on ? null : TextDecorations.Strikethrough;
        turn.Angle = Node.Expanded ? 90 : 0;
        if (was != State && AutomationPeer.ListenerExists(AutomationEvents.PropertyChanged)
            && UIElementAutomationPeer.FromElement(this) is { } peer)
        {
            peer.RaisePropertyChangedEvent(TogglePatternIdentifiers.ToggleStateProperty, was, State);
        }
    }

    protected override void OnExpanded(RoutedEventArgs e)
    {
        base.OnExpanded(e);
        turn.Angle = 90;
    }

    protected override void OnCollapsed(RoutedEventArgs e)
    {
        base.OnCollapsed(e);
        turn.Angle = 0;
    }

    /// <summary>
    /// A click: on the box it ticks or unticks, on a folder's arrow or name it opens or closes, on a
    /// file's name it shows the file; anywhere the row takes the focus. Not TreeView's double-click.
    /// </summary>
    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        e.Handled = true;
        Focus();
        var hit = e.OriginalSource as DependencyObject;
        if (Inside(hit, box)) Tree.Toggle(Node);
        else if (Node.Dir && (Inside(hit, twisty) || Inside(hit, name))) Tree.SetExpanded(Node, !Node.Expanded);
        else if (!Node.Dir && Inside(hit, name)) Tree.Open(Node, this);
    }

    static bool Inside(DependencyObject? d, DependencyObject ancestor)
    {
        for (var at = d; at is not null; at = at is Visual or System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(at) : LogicalTreeHelper.GetParent(at))
            if (at == ancestor) return true;
        return false;
    }

    protected override void OnGotKeyboardFocus(KeyboardFocusChangedEventArgs e)
    {
        base.OnGotKeyboardFocus(e);
        if (e.NewFocus != this) return;
        Tree.Current = Node;
        Ring = KeepRing || InputManager.Current.MostRecentInputDevice is KeyboardDevice;
    }

    protected override void OnLostKeyboardFocus(KeyboardFocusChangedEventArgs e)
    {
        base.OnLostKeyboardFocus(e);
        if (e.OldFocus == this && !KeepRing) Ring = false;
    }
}

/// <summary>
/// A row's parts in a line, as the page's flex row: the arrow, box and icon, then the name, then a
/// folder's count beside it or a file's details at the end; what does not fit beside the name goes
/// below it, and a note under all of them.
/// </summary>
sealed class RowPanel : Panel
{
    const double Gap = 10;
    readonly UIElement lead;
    readonly UIElement name;
    readonly UIElement? extra;
    readonly UIElement? hint;
    readonly bool atEnd;
    bool narrow;
    bool oneLine;

    public RowPanel(UIElement lead, UIElement name, UIElement? extra, UIElement? hint, bool atEnd)
    {
        this.lead = lead;
        this.name = name;
        this.extra = extra;
        this.hint = hint;
        this.atEnd = atEnd;
        foreach (var e in new[] { lead, name, extra, hint }) if (e is not null) Children.Add(e);
    }

    /// <summary>A narrow tree puts a file's details below its name at once.</summary>
    public bool Narrow
    {
        get => narrow;
        set
        {
            if (narrow == value) return;
            narrow = value;
            InvalidateMeasure();
        }
    }

    protected override Size MeasureOverride(Size available)
    {
        lead.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        double lw = lead.DesiredSize.Width + Gap;
        double width = double.IsInfinity(available.Width) ? double.PositiveInfinity : available.Width;
        double rest = Math.Max(0, width - lw);
        name.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        double nw = name.DesiredSize.Width;
        double ew = 0;
        if (extra is not null)
        {
            extra.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            ew = extra.DesiredSize.Width;
        }
        oneLine = extra is null || (!(narrow && atEnd) && nw + Gap + ew <= rest);
        if (oneLine)
        {
            name.Measure(new Size(Math.Max(0, rest - (extra is null ? 0 : ew + Gap)), double.PositiveInfinity));
        }
        else
        {
            name.Measure(new Size(rest, double.PositiveInfinity));
            extra!.Measure(new Size(rest, double.PositiveInfinity));
        }
        double line1 = Math.Max(lead.DesiredSize.Height, Math.Max(name.DesiredSize.Height, oneLine && extra is not null ? extra.DesiredSize.Height : 0));
        line1 = Math.Max(line1, 32);
        double line2 = oneLine ? 0 : extra!.DesiredSize.Height + 2;
        double h = 0;
        if (hint is not null)
        {
            hint.Measure(new Size(rest, double.PositiveInfinity));
            h = hint.DesiredSize.Height;
        }
        double w = double.IsInfinity(width) ? lw + nw + (extra is null ? 0 : Gap + ew) : width;
        return new Size(w, line1 + line2 + h);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double lw = lead.DesiredSize.Width + Gap;
        double rest = Math.Max(0, final.Width - lw);
        double line1 = Math.Max(lead.DesiredSize.Height, Math.Max(name.DesiredSize.Height, oneLine && extra is not null ? extra.DesiredSize.Height : 0));
        line1 = Math.Max(line1, 32);
        lead.Arrange(new Rect(0, (line1 - lead.DesiredSize.Height) / 2, lead.DesiredSize.Width, lead.DesiredSize.Height));
        double nw = Math.Min(name.DesiredSize.Width, rest);
        name.Arrange(new Rect(lw, (line1 - name.DesiredSize.Height) / 2, nw, name.DesiredSize.Height));
        double y = line1;
        if (extra is not null)
        {
            var e = extra.DesiredSize;
            if (oneLine)
            {
                double x = atEnd ? final.Width - e.Width : lw + nw + Gap;
                extra.Arrange(new Rect(Math.Max(lw, x), (line1 - e.Height) / 2, e.Width, e.Height));
            }
            else
            {
                double x = atEnd ? final.Width - Math.Min(e.Width, rest) : lw;
                extra.Arrange(new Rect(Math.Max(lw, x), y + 2, Math.Min(e.Width, rest), e.Height));
                y += e.Height + 2;
            }
        }
        hint?.Arrange(new Rect(lw, y, rest, hint.DesiredSize.Height));
        return final;
    }
}
