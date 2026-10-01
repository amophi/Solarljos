using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;

namespace Solarljos.Ui;

/// <summary>
/// An element that assistive technology knows as what it is -- a group named for the file of a
/// card, a list, the choices of a legend -- with the name AutomationProperties gives it: the
/// page's article labelled by its file's name, its fieldset and legend. A plain panel or border
/// has no automation peer, so a name put on one never reaches UI Automation.
/// </summary>
public class Labeled : Border
{
    public AutomationControlType Kind { get; init; } = AutomationControlType.Group;

    /// <summary>A group of these, named.</summary>
    public static Labeled Group(string name, UIElement child)
    {
        var l = new Labeled { Child = child };
        AutomationProperties.SetName(l, name);
        return l;
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

    sealed class Peer(Labeled owner) : FrameworkElementAutomationPeer(owner)
    {
        protected override AutomationControlType GetAutomationControlTypeCore() => owner.Kind;
        protected override string GetClassNameCore() => owner.Kind.ToString();
        protected override bool IsControlElementCore() => true;
        protected override bool IsContentElementCore() => true;
    }
}
