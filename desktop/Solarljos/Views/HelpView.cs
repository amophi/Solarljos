using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views;

/// <summary>The part of the window for nav.help: still to be made (see the brief in the scratchpad).</summary>
public sealed class HelpView : UserControl, IPage
{
    public event Action? HeadingChanged;

    public HelpView()
    {
        Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.help"]));
        Tr.Instance.Changed += () =>
        {
            Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.help"]));
            HeadingChanged?.Invoke();
        };
    }

    public string? Heading => Tr.Instance["nav.help"];

    public void Connected(Session session) { }

    public void Shown(string sub) { }
}
