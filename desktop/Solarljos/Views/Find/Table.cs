using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Media;
using Solarljos.Ui;

namespace Solarljos.Views.Find;

/// <summary>
/// One column of a table: as wide as its widest cell, or, with `Fill`, taking a share of the room
/// left, at least `Min` while there is room for that, and never less than `Floor`; a `Late` one
/// gives up its least only once the others are down to their floor.
/// </summary>
public sealed record TableColumn(bool Fill = false, double Min = 0, bool End = false, double Floor = 64, bool Late = false);

/// <summary>
/// A table as the page draws its own (table.copies, table.hex): a row of headings, then rows,
/// each column as wide as its widest cell -- the columns that fill sharing what room is left --
/// and, where even their least is more than the room there is, wider than it, for a scroller
/// around it to move sideways (the page's .table-wrap). Each row is a TableRow, each cell a
/// TableCell; assistive technology knows the table as a grid, as it knows the page's: how many
/// rows and columns it has, each cell's row and column, and the heading of each column, for a
/// screen reader to move through it by row or by column and say the heading it comes to.
/// </summary>
public sealed class Table : Panel
{
    public IReadOnlyList<TableColumn> Columns { get; }
    /// <summary>Room around each cell's content, left and right; above and below.</summary>
    public double PadX { get; init; } = 12;
    public double PadY { get; init; } = 10;
    /// <summary>The first and the last cell's room at the edge of the table.</summary>
    public double EdgeStart { get; init; } = 12;
    public double EdgeEnd { get; init; } = 12;

    internal double[] Widths = [];
    double room = double.NaN;

    public Table(params TableColumn[] columns) => Columns = columns;

    /// <summary>
    /// The width there is for it, where what holds it gives it no end: a scroller that moves it
    /// sideways. The columns that fill share that, and the table is wider only when their least is.
    /// </summary>
    public double Room
    {
        get => room;
        set
        {
            if (room.Equals(value)) return;
            room = value;
            InvalidateMeasure();
        }
    }

    /// <summary>Puts the table in a scroller that moves it sideways where it must, and gives it the scroller's width as its room.</summary>
    public ScrollViewer InScroller()
    {
        var sv = new ScrollViewer
        {
            Content = this, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false,
        };
        sv.SizeChanged += (_, e) => Room = e.NewSize.Width;
        Sideways(sv);
        return sv;
    }

    /// <summary>Shift and the mouse wheel move a scroller that goes sideways; without Shift the wheel goes on to the page.</summary>
    public static void Sideways(ScrollViewer sv)
    {
        sv.PreviewMouseWheel += (_, e) =>
        {
            if (System.Windows.Input.Keyboard.Modifiers != System.Windows.Input.ModifierKeys.Shift || sv.ScrollableWidth <= 0) return;
            sv.ScrollToHorizontalOffset(sv.HorizontalOffset - e.Delta);
            e.Handled = true;
        };
    }

    double Pad(int i) => (i == 0 ? EdgeStart : PadX) + (i == Columns.Count - 1 ? EdgeEnd : PadX);

    protected override Size MeasureOverride(Size available)
    {
        var rows = InternalChildren.OfType<TableRow>().Where((r) => r.Visibility != Visibility.Collapsed).ToList();
        int n = Columns.Count;
        var natural = new double[n];
        var least = new double[n];
        foreach (var row in rows)
        {
            for (int i = 0; i < n && i < row.Cells.Count; i++)
            {
                var cell = row.Cells[i];
                cell.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                natural[i] = Math.Max(natural[i], cell.DesiredSize.Width + Pad(i));
            }
        }
        var floor = new double[n];
        for (int i = 0; i < n; i++)
        {
            least[i] = Columns[i].Fill ? Math.Min(natural[i], Columns[i].Min + Pad(i)) : natural[i];
            floor[i] = Columns[i].Fill ? Math.Min(least[i], Columns[i].Floor + Pad(i)) : natural[i];
        }
        var widths = new double[n];
        double fixedSum = 0, fillNatural = 0, fillLeast = 0, fillFloor = 0;
        for (int i = 0; i < n; i++)
        {
            if (Columns[i].Fill)
            {
                fillNatural += natural[i];
                fillLeast += least[i];
                fillFloor += floor[i];
            }
            else
            {
                widths[i] = natural[i];
                fixedSum += natural[i];
            }
        }
        double width = !double.IsInfinity(available.Width) ? available.Width : double.IsNaN(room) ? fixedSum + fillNatural : room;
        double left = width - fixedSum;
        for (int i = 0; i < n; i++)
        {
            if (!Columns[i].Fill) continue;
            if (left >= fillNatural)
            {
                // Everything fits: the room left over goes to the columns that fill, as their widths stand.
                widths[i] = natural[i] + (fillNatural > 0 ? (left - fillNatural) * natural[i] / fillNatural : 0);
            }
            else if (left >= fillLeast)
            {
                // Each gets its least, and of the rest a share as large as what more it would take.
                double want = fillNatural - fillLeast;
                widths[i] = least[i] + (want > 0 ? (left - fillLeast) * (natural[i] - least[i]) / want : 0);
            }
            else widths[i] = floor[i];
        }
        if (left < fillLeast && left > fillFloor)
        {
            // Less than that: each gives up some of its least, down to its floor, rather than the
            // table running past the room; first those that are not late, then the late ones.
            double earlyLeast = 0, earlyFloor = 0, lateLeast = 0, lateFloor = 0;
            for (int i = 0; i < n; i++)
            {
                if (!Columns[i].Fill) continue;
                if (Columns[i].Late)
                {
                    lateLeast += least[i];
                    lateFloor += floor[i];
                }
                else
                {
                    earlyLeast += least[i];
                    earlyFloor += floor[i];
                }
            }
            bool earlyGive = left >= lateLeast + earlyFloor;
            for (int i = 0; i < n; i++)
            {
                if (!Columns[i].Fill) continue;
                bool late = Columns[i].Late;
                if (earlyGive)
                {
                    double give = earlyLeast - earlyFloor;
                    widths[i] = late ? least[i] : floor[i] + (give > 0 ? (left - lateLeast - earlyFloor) * (least[i] - floor[i]) / give : 0);
                }
                else
                {
                    double give = lateLeast - lateFloor;
                    widths[i] = !late ? floor[i] : floor[i] + (give > 0 ? (left - earlyFloor - lateFloor) * (least[i] - floor[i]) / give : 0);
                }
            }
        }
        Widths = widths;
        double height = 0;
        foreach (var row in rows)
        {
            row.Measure(new Size(widths.Sum(), double.PositiveInfinity));
            height += row.DesiredSize.Height;
        }
        return new Size(widths.Sum(), height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double y = 0;
        double width = Math.Max(final.Width, Widths.Sum());
        foreach (var row in InternalChildren.OfType<TableRow>())
        {
            if (row.Visibility == Visibility.Collapsed) continue;
            row.Arrange(new Rect(0, y, width, row.DesiredSize.Height));
            y += row.DesiredSize.Height;
        }
        return new Size(width, y);
    }

    /// <summary>Its rows below the headings, as they are shown.</summary>
    internal List<TableRow> DataRows() => InternalChildren.OfType<TableRow>().Where((r) => !r.IsHeader && r.Visibility != Visibility.Collapsed).ToList();

    internal TableRow? HeaderRow => InternalChildren.OfType<TableRow>().FirstOrDefault((r) => r.IsHeader);

    protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

    sealed class Peer(Table owner) : FrameworkElementAutomationPeer(owner), IGridProvider, ITableProvider
    {
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Table;
        protected override string GetClassNameCore() => "Table";
        protected override bool IsControlElementCore() => true;

        public override object GetPattern(PatternInterface pattern) =>
            pattern is PatternInterface.Grid or PatternInterface.Table ? this : base.GetPattern(pattern);

        public int RowCount => owner.DataRows().Count;
        public int ColumnCount => owner.Columns.Count;

        public IRawElementProviderSimple? GetItem(int row, int column) =>
            owner.DataRows().ElementAtOrDefault(row)?.Cells.ElementAtOrDefault(column) is { } cell ? Provider(cell) : null;

        public RowOrColumnMajor RowOrColumnMajor => RowOrColumnMajor.RowMajor;

        public IRawElementProviderSimple[] GetRowHeaders() => [];

        public IRawElementProviderSimple[] GetColumnHeaders() =>
            owner.HeaderRow?.Cells.Select(Provider).OfType<IRawElementProviderSimple>().ToArray() ?? [];

        IRawElementProviderSimple? Provider(UIElement e) => CreatePeerForElement(e) is { } p ? ProviderFromPeer(p) : null;
    }

    internal double CellPad(int i, bool start) => i == 0 && start ? EdgeStart : i == Columns.Count - 1 && !start ? EdgeEnd : PadX;
}

/// <summary>
/// A row of a Table: its cells in the table's columns, a line below it, and a tint where the
/// mouse is; the heading row in the raised colour, its words small, bold and in the second
/// colour of the text.
/// </summary>
public sealed class TableRow : Panel
{
    public List<TableCell> Cells { get; } = new();
    public bool IsHeader { get; }
    bool last;

    /// <summary>Whether a line is drawn below it: not below the last row of a table.</summary>
    public bool LineBelow
    {
        get => !last;
        set
        {
            if (last == !value) return;
            last = !value;
            InvalidateMeasure();
            InvalidateVisual();
        }
    }

    public static readonly DependencyProperty LineProperty = DependencyProperty.Register(
        nameof(Line), typeof(Brush), typeof(TableRow), new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsRender));

    public Brush? Line { get => (Brush?)GetValue(LineProperty); set => SetValue(LineProperty, value); }

    public TableRow(bool header, IEnumerable<FrameworkElement?> cells, bool lineBelow = true)
    {
        IsHeader = header;
        last = !lineBelow;
        foreach (var c in cells)
        {
            var cell = new TableCell(c ?? new TextBlock());
            Cells.Add(cell);
            Children.Add(cell);
        }
        SetResourceReference(LineProperty, "Divider");
        if (header) SetResourceReference(BackgroundProperty, "Raised");
        else
        {
            Background = Brushes.Transparent;
            MouseEnter += (_, _) => SetResourceReference(BackgroundProperty, "Hover");
            MouseLeave += (_, _) => Background = Brushes.Transparent;
        }
    }

    internal Table? Owner => Parent as Table;

    protected override Size MeasureOverride(Size available)
    {
        var t = Owner;
        if (t is null || t.Widths.Length == 0) return default;
        double height = 0;
        for (int i = 0; i < Cells.Count && i < t.Widths.Length; i++)
        {
            double w = Math.Max(0, t.Widths[i] - t.CellPad(i, true) - t.CellPad(i, false));
            Cells[i].Measure(new Size(w, double.PositiveInfinity));
            height = Math.Max(height, Cells[i].DesiredSize.Height);
        }
        return new Size(t.Widths.Sum(), height + 2 * t.PadY + (last ? 0 : 1));
    }

    protected override Size ArrangeOverride(Size final)
    {
        var t = Owner;
        if (t is null) return final;
        double x = 0;
        double inner = final.Height - 2 * t.PadY - (last ? 0 : 1);
        for (int i = 0; i < Cells.Count && i < t.Widths.Length; i++)
        {
            double start = t.CellPad(i, true), end = t.CellPad(i, false);
            double w = Math.Max(0, t.Widths[i] - start - end);
            var cell = Cells[i];
            double cw = Math.Min(w, cell.DesiredSize.Width);
            // Numbers at the end of their cell, the rest at its start; every cell in the middle of the row's height.
            double cx = t.Columns[i].End ? x + start + (w - cw) : x + start;
            if (cell.HorizontalAlignment == HorizontalAlignment.Stretch && !t.Columns[i].End) cw = w;
            double ch = Math.Min(inner, cell.DesiredSize.Height);
            cell.Arrange(new Rect(cx, t.PadY + (inner - ch) / 2, cw, ch));
            x += t.Widths[i];
        }
        return final;
    }

    protected override void OnRender(DrawingContext dc)
    {
        base.OnRender(dc);
        if (!last && Line is { } line) dc.DrawRectangle(line, null, new Rect(0, ActualHeight - 1, ActualWidth, 1));
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

    sealed class Peer(TableRow owner) : FrameworkElementAutomationPeer(owner)
    {
        protected override AutomationControlType GetAutomationControlTypeCore() => owner.IsHeader ? AutomationControlType.Header : AutomationControlType.DataItem;
        protected override string GetClassNameCore() => owner.IsHeader ? "Header" : "DataItem";
        protected override bool IsControlElementCore() => true;
    }

    /// <summary>A heading cell: small, bold, in the second colour, on one line.</summary>
    public static TextBlock Head(string text, bool end = false)
    {
        var tb = new TextBlock { Text = text, FontSize = 13, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.NoWrap };
        tb.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
        if (end) tb.TextAlignment = TextAlignment.Right;
        return tb;
    }

    /// <summary>A cell of words, 14 pixels as the page's tables have them.</summary>
    public static TextBlock Cell(string text, bool wrap = true, string colour = "Text")
    {
        var tb = new TextBlock { Text = text, FontSize = 14, LineHeight = 20, TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap };
        tb.SetResourceReference(TextBlock.ForegroundProperty, colour);
        return tb;
    }
}

/// <summary>
/// A cell of a TableRow, around what it shows, which takes the place in its column that what it
/// holds asks for. To assistive technology it is a heading of its column (the page's th), or a
/// cell (td) with its row, its column and that column's heading; named by what it says -- its
/// words, or the name of what it holds, a badge's -- for a row is not named for all its cells at once.
/// </summary>
public sealed class TableCell : Decorator
{
    public TableCell(FrameworkElement content)
    {
        Child = content;
        HorizontalAlignment = content.HorizontalAlignment;
    }

    TableRow? Row => Parent as TableRow;

    protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

    sealed class Peer(TableCell owner) : FrameworkElementAutomationPeer(owner), IGridItemProvider, ITableItemProvider
    {
        bool Head => owner.Row?.IsHeader == true;

        protected override AutomationControlType GetAutomationControlTypeCore() => Head ? AutomationControlType.HeaderItem : AutomationControlType.DataItem;
        protected override string GetClassNameCore() => Head ? "HeaderItem" : "DataItem";
        protected override bool IsControlElementCore() => true;
        protected override bool IsContentElementCore() => true;

        protected override string GetNameCore()
        {
            if (base.GetNameCore() is { Length: > 0 } name) return name;
            return owner.Child switch
            {
                TextBlock tb => tb.Text,
                UIElement e => AutomationProperties.GetName(e),
                _ => "",
            };
        }

        protected override string GetHelpTextCore() =>
            base.GetHelpTextCore() is { Length: > 0 } help ? help : owner.Child is { } e ? AutomationProperties.GetHelpText(e) : "";

        public override object GetPattern(PatternInterface pattern) =>
            !Head && (pattern is PatternInterface.GridItem or PatternInterface.TableItem) ? this : base.GetPattern(pattern);

        public int Row => owner.Row is { Owner: { } t } r ? t.DataRows().IndexOf(r) : -1;
        public int Column => owner.Row?.Cells.IndexOf(owner) ?? -1;
        public int RowSpan => 1;
        public int ColumnSpan => 1;

        public IRawElementProviderSimple? ContainingGrid => owner.Row?.Owner is { } t ? Provider(t) : null;

        public IRawElementProviderSimple[] GetRowHeaderItems() => [];

        public IRawElementProviderSimple[] GetColumnHeaderItems() =>
            owner.Row?.Owner?.HeaderRow?.Cells.ElementAtOrDefault(Column) is { } head && Provider(head) is { } p ? [p] : [];

        IRawElementProviderSimple? Provider(UIElement e) => CreatePeerForElement(e) is { } p ? ProviderFromPeer(p) : null;
    }
}
