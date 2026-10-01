using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views;

/// <summary>The part of the window for nav.sources: still to be made (see the brief in the scratchpad).</summary>
public sealed class SourcesView : UserControl, IPage
{
    public event Action? HeadingChanged;

    public SourcesView()
    {
        Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.sources"]));
        Tr.Instance.Changed += () =>
        {
            Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.sources"]));
            HeadingChanged?.Invoke();
        };
    }

    public string? Heading => Tr.Instance["nav.sources"];

    public void Connected(Session session) { }

    public void Shown(string sub) { }
}
