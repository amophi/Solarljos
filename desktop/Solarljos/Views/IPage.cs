using Solarljos.Core;

namespace Solarljos.Views;

/// <summary>
/// A part of the window, kept while another is shown, as the page keeps its views: what was
/// typed, chosen, scrolled to and found stays until it is left for good.
/// </summary>
public interface IPage
{
    /// <summary>The heading of what it shows now, for the window's title; null on the start.</summary>
    string? Heading { get; }

    /// <summary>Its heading changed: another view of the part, or another language.</summary>
    event Action? HeadingChanged;

    /// <summary>The engine is there: its session, for what the part asks of it.</summary>
    void Connected(Session session) { }

    /// <summary>It comes into sight, at `sub` -- "results" in "find/results" -- or as it was left, for "".</summary>
    void Shown(string sub) { }

    /// <summary>For the pictures of the window (Dev/Shot.cs): what to do first, by name.</summary>
    Task ActAsync(string act) => Task.CompletedTask;
}
