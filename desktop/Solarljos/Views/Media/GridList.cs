using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Solarljos.Views.Media;

/// <summary>
/// The grid's one scroller: its heading and choices first, then each month's heading and its rows
/// of tiles. Only the rows in sight, and a screen's worth either side, are made (a virtualizing
/// panel), so a grid of thousands scrolls as lightly as one of ten; a row that goes out of sight
/// gives its tiles back to be used again. What the page lays out as one long column is the same
/// column here, made as it comes near.
/// </summary>
public sealed class GridList : ItemsControl
{
    /// <summary>The panel that lays the rows out, once it is there.</summary>
    public GridRows? Rows { get; internal set; }

    public ScrollViewer? Scroller { get; private set; }

    /// <summary>A row comes into sight, with the item it is to show; and goes out of it.</summary>
    public Action<RowHost, object>? Prepare { get; set; }
    public Action<RowHost, object>? Release { get; set; }

    /// <summary>The tiles drawn now that are selected, which assistive technology is told of as the grid's selection.</summary>
    public Func<IEnumerable<UIElement>>? Selection { get; set; }

    public GridList()
    {
        var scroll = new FrameworkElementFactory(typeof(RowsScroller), "PART_Scroll");
        scroll.SetValue(ScrollViewer.CanContentScrollProperty, true);
        scroll.SetValue(ScrollViewer.HorizontalScrollBarVisibilityProperty, ScrollBarVisibility.Disabled);
        scroll.SetValue(ScrollViewer.VerticalScrollBarVisibilityProperty, ScrollBarVisibility.Auto);
        scroll.SetValue(FocusableProperty, false);
        scroll.AppendChild(new FrameworkElementFactory(typeof(ItemsPresenter)));
        Template = new ControlTemplate(typeof(GridList)) { VisualTree = scroll };
        ItemsPanel = new ItemsPanelTemplate(new FrameworkElementFactory(typeof(GridRows)));
        VirtualizingPanel.SetIsVirtualizing(this, true);
        VirtualizingPanel.SetVirtualizationMode(this, VirtualizationMode.Standard);
        VirtualizingPanel.SetScrollUnit(this, ScrollUnit.Pixel);
        VirtualizingPanel.SetCacheLengthUnit(this, VirtualizationCacheLengthUnit.Page);
        VirtualizingPanel.SetCacheLength(this, new VirtualizationCacheLength(1, 1));
        Focusable = false;
        KeyboardNavigation.SetTabNavigation(this, KeyboardNavigationMode.Continue);
        KeyboardNavigation.SetDirectionalNavigation(this, KeyboardNavigationMode.None);
        // The wheel moves the photos as far as a browser does, not three lines of text.
        PreviewMouseWheel += (_, e) =>
        {
            if (Scroller is null || Mouse.DirectlyOver is not DependencyObject over || !IsAncestorOf(over)) return;
            Scroller.ScrollToVerticalOffset(Scroller.VerticalOffset - e.Delta);
            e.Handled = true;
        };
    }

    public override void OnApplyTemplate()
    {
        base.OnApplyTemplate();
        Scroller = GetTemplateChild("PART_Scroll") as ScrollViewer;
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new GridListPeer(this);

    /// <summary>
    /// The grid to assistive technology: a list in which several tiles can be selected (the page's
    /// grid, aria-multiselectable), holding what its rows draw now -- the heading and the choices,
    /// each month's heading and its tiles -- as the window shows them. An ItemsControl's own would
    /// read out each row as an item named by what the program calls it. The scroller is passed by,
    /// as a list box's is, and its scrolling is the list's.
    /// </summary>
    sealed class GridListPeer(GridList owner) : FrameworkElementAutomationPeer(owner), ISelectionProvider
    {
        ScrollViewerAutomationPeer? scroll;

        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.List;

        protected override string GetClassNameCore() => "GridList";

        protected override List<AutomationPeer>? GetChildrenCore()
        {
            if (owner.Rows is not { } rows) return null;
            var found = new List<AutomationPeer>();
            Collect(rows, found);
            return found.Count > 0 ? found : null;
        }

        /// <summary>The nearest elements under one that assistive technology knows, as an element's own peer finds them.</summary>
        static void Collect(DependencyObject at, List<AutomationPeer> into)
        {
            for (int i = 0, n = VisualTreeHelper.GetChildrenCount(at); i < n; i++)
            {
                var child = VisualTreeHelper.GetChild(at, i);
                if (child is UIElement e && UIElementAutomationPeer.CreatePeerForElement(e) is { } peer) into.Add(peer);
                else Collect(child, into);
            }
        }

        public override object GetPattern(PatternInterface p)
        {
            if (p == PatternInterface.Selection) return this;
            if (p == PatternInterface.Scroll && owner.Scroller is { } s) return scroll ??= new ScrollViewerAutomationPeer(s);
            return base.GetPattern(p)!;
        }

        public bool CanSelectMultiple => true;

        public bool IsSelectionRequired => false;

        public IRawElementProviderSimple[] GetSelection() =>
            (owner.Selection?.Invoke() ?? []).Select(UIElementAutomationPeer.CreatePeerForElement).OfType<AutomationPeer>().Select(ProviderFromPeer).ToArray();
    }

    protected override bool IsItemItsOwnContainerOverride(object item) => item is UIElement;

    protected override DependencyObject GetContainerForItemOverride() => new RowHost();

    protected override void PrepareContainerForItemOverride(DependencyObject element, object item)
    {
        base.PrepareContainerForItemOverride(element, item);
        if (element is RowHost host)
        {
            host.Item = item;
            Prepare?.Invoke(host, item);
        }
    }

    protected override void ClearContainerForItemOverride(DependencyObject element, object item)
    {
        if (element is RowHost host)
        {
            Release?.Invoke(host, item);
            host.Item = null;
        }
        base.ClearContainerForItemOverride(element, item);
    }

    /// <summary>The row of an item made, bringing it into sight first when it is not.</summary>
    public FrameworkElement? Realize(int index)
    {
        if (index < 0 || index >= Items.Count) return null;
        if (ItemContainerGenerator.ContainerFromIndex(index) is FrameworkElement made) return made;
        Rows?.BringIntoView(index);
        UpdateLayout();
        return ItemContainerGenerator.ContainerFromIndex(index) as FrameworkElement;
    }
}

/// <summary>The panel of the grid's rows, which makes only those near the screen.</summary>
public sealed class GridRows : VirtualizingStackPanel
{
    protected override void OnIsItemsHostChanged(bool oldIsItemsHost, bool newIsItemsHost)
    {
        base.OnIsItemsHostChanged(oldIsItemsHost, newIsItemsHost);
        if (newIsItemsHost && ItemsControl.GetItemsOwner(this) is GridList list) list.Rows = this;
    }

    public void BringIntoView(int index) => BringIndexIntoViewPublic(index);
}

/// <summary>The grid's scroller, which assistive technology does not see: the grid stands for it (GridListPeer).</summary>
public sealed class RowsScroller : ScrollViewer
{
    protected override AutomationPeer? OnCreateAutomationPeer() => null;
}

/// <summary>Where one row of the grid is drawn: a month's heading, or a row of tiles.</summary>
public sealed class RowHost : Border
{
    public object? Item { get; set; }
}
