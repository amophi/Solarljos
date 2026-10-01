using System.Windows;
using System.Windows.Controls;

namespace Solarljos.Views;

public partial class HomeView : UserControl, IPage
{
    readonly MainWindow window;

    public event Action? HeadingChanged { add { } remove { } }

    public HomeView(MainWindow window)
    {
        this.window = window;
        InitializeComponent();
        // Three cards side by side where they fit, one above the other where they do not.
        SizeChanged += (_, _) => Choices.Columns = ActualWidth >= 800 ? 3 : 1;
    }

    // The start's heading is the name, which the window's title does not say twice.
    public string? Heading => null;

    void Choice_Click(object sender, RoutedEventArgs e) => window.Go((string)((FrameworkElement)sender).Tag);
}
