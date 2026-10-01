using System.Windows;
using System.Windows.Controls;

namespace Solarljos.Views.Sources;

/// <summary>
/// The cards of what is searched, as the page lays them out (.source-cards in style.css): as many
/// columns as fit at 22rem (352 pixels) or more each, sharing the width, 16 pixels apart; the
/// cards of a row as tall as its tallest, so that each one's button sits at its foot.
/// </summary>
public sealed class CardGrid : Panel
{
    public double MinColumn { get; set; } = 352;
    public double Gap { get; set; } = 16;

    int columns = 1;
    double columnWidth;
    readonly List<double> rows = new();

    protected override Size MeasureOverride(Size available)
    {
        double width = double.IsInfinity(available.Width) ? MinColumn : available.Width;
        columns = Math.Max(1, (int)Math.Floor((width + Gap) / (MinColumn + Gap)));
        columnWidth = Math.Max(0, (width - Gap * (columns - 1)) / columns);
        rows.Clear();
        var kids = InternalChildren.Cast<UIElement>().Where((c) => c.Visibility != Visibility.Collapsed).ToList();
        for (int i = 0; i < kids.Count; i++)
        {
            kids[i].Measure(new Size(columnWidth, double.PositiveInfinity));
            int row = i / columns;
            if (rows.Count <= row) rows.Add(0);
            rows[row] = Math.Max(rows[row], kids[i].DesiredSize.Height);
        }
        double height = rows.Sum() + Gap * Math.Max(0, rows.Count - 1);
        return new Size(width, height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        var kids = InternalChildren.Cast<UIElement>().Where((c) => c.Visibility != Visibility.Collapsed).ToList();
        double top = 0;
        for (int i = 0; i < kids.Count; i++)
        {
            int row = i / columns, col = i % columns;
            if (col == 0 && row > 0) top += rows[row - 1] + Gap;
            kids[i].Arrange(new Rect(col * (columnWidth + Gap), top, columnWidth, row < rows.Count ? rows[row] : 0));
        }
        return final;
    }
}
