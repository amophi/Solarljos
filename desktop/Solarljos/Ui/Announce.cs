using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;

namespace Solarljos.Ui;

/// <summary>
/// What a screen reader is told without the focus moving: how a search went, that a language
/// changed -- the page's polite region -- and what went wrong, said at once -- its assertive one.
/// Through UI Automation's notification event, which Narrator and NVDA read.
/// </summary>
public static class Announce
{
    public static void Say(string message) => Raise(message, AutomationNotificationProcessing.MostRecent);

    public static void Alert(string message) => Raise(message, AutomationNotificationProcessing.ImportantMostRecent);

    static void Raise(string message, AutomationNotificationProcessing how)
    {
        if (Application.Current?.MainWindow is not { } w || string.IsNullOrWhiteSpace(message)) return;
        var peer = UIElementAutomationPeer.FromElement(w) ?? UIElementAutomationPeer.CreatePeerForElement(w);
        peer?.RaiseNotificationEvent(AutomationNotificationKind.Other, how, message, "solarljos");
    }
}
