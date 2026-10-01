using System.Windows.Automation.Peers;
using System.Windows.Controls;

namespace Solarljos.Ui;

/// <summary>
/// Words for the eye only, which assistive technology does not see: a list's bullet, the words of
/// an item already named by them, a heading already said where it is.
/// </summary>
public sealed class SilentText : TextBlock
{
    protected override AutomationPeer? OnCreateAutomationPeer() => null;
}
