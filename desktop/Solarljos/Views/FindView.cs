using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views;

/// <summary>The part of the window for nav.find: still to be made (see the brief in the scratchpad).</summary>
public sealed class FindView : UserControl, IPage
{
    public event Action? HeadingChanged;

    public FindView()
    {
        Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.find"]));
        Tr.Instance.Changed += () =>
        {
            Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.find"]));
            HeadingChanged?.Invoke();
        };
    }

    public string? Heading => Tr.Instance["nav.find"];

    public void Connected(Session session) { }

    public void Shown(string sub) { }
}
