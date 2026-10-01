using System.Windows.Controls;
using Solarljos.Text;

namespace Solarljos.Views;

public partial class PendingView : UserControl, IPage
{
    readonly string key;

    public event Action? HeadingChanged;

    public PendingView(string name)
    {
        InitializeComponent();
        key = "nav." + name;
        Show();
        Tr.Instance.Changed += () =>
        {
            Show();
            HeadingChanged?.Invoke();
        };
    }

    void Show() => HeadingText.Text = Tr.Instance[key];

    TextBlock HeadingText => Heading;

    string? IPage.Heading => Tr.Instance[key];
}
