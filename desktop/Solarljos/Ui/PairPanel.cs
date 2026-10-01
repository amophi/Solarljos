using System.Windows;
using System.Windows.Controls;

namespace Solarljos.Ui;

/// <summary>
/// Options side by side, two to a row where the room is there for both (each at least 352
/// pixels, 40 between them), one above the other where it is not -- the page's .form-pair. A row
/// is as high as the higher of its two.
/// </summary>
public sealed class PairPanel : Panel
{
    public double MinColumn { get; set; } = 352;
    public double ColumnGap { get; set; } = 40;
    public double RowGap { get; set; } = 16;

    int Columns(double width) => !double.IsInfinity(width) && width >= MinColumn * 2 + ColumnGap ? 2 : 1;

    protected override Size MeasureOverride(Size available)
    {
        var visible = InternalChildren.Cast<UIElement>().Where((c) => c.Visibility != Visibility.Collapsed).ToList();
        int cols = Columns(available.Width);
        double colWidth = cols == 2 ? (available.Width - ColumnGap) / 2 : available.Width;
        double height = 0, widest = 0;
        for (int i = 0; i < visible.Count; i += cols)
        {
            double row = 0;
            for (int j = i; j < Math.Min(i + cols, visible.Count); j++)
            {
                visible[j].Measure(new Size(colWidth, double.PositiveInfinity));
                row = Math.Max(row, visible[j].DesiredSize.Height);
                widest = Math.Max(widest, visible[j].DesiredSize.Width);
            }
            height += row + (i > 0 ? RowGap : 0);
        }
        return new Size(double.IsInfinity(available.Width) ? widest : available.Width, height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        var visible = InternalChildren.Cast<UIElement>().Where((c) => c.Visibility != Visibility.Collapsed).ToList();
        int cols = Columns(final.Width);
        double colWidth = cols == 2 ? (final.Width - ColumnGap) / 2 : final.Width;
        double y = 0;
        for (int i = 0; i < visible.Count; i += cols)
        {
            double row = 0;
            for (int j = i; j < Math.Min(i + cols, visible.Count); j++) row = Math.Max(row, visible[j].DesiredSize.Height);
            for (int j = i; j < Math.Min(i + cols, visible.Count); j++)
                visible[j].Arrange(new Rect((j - i) * (colWidth + ColumnGap), y, colWidth, row));
            y += row + RowGap;
        }
        return final;
    }
}
