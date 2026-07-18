#!/usr/bin/env python3
"""Desktop notifier for JobFinder.

Invoked by the Next.js `/api/notify` route as:

    python scripts/notify.py --title "..." --message "..."

Shows a native Windows toast. It tries the optional `win11toast` / `win10toast`
packages first (nicer toasts), and otherwise falls back to a dependency-free
PowerShell/WinRT toast so it works on a stock Windows install. Exits 0 on
success, 1 if every backend failed.

This is the single place desktop notifications are produced — extend it here
(sound, actions, other channels) without touching the web app.
"""
import argparse
import os
import subprocess
import sys

APP_ID = "JobFinder"


def _win11toast(title: str, message: str) -> bool:
    try:
        from win11toast import toast  # type: ignore
    except Exception:
        return False
    try:
        toast(title, message, app_id=APP_ID)
        return True
    except Exception:
        return False


def _win10toast(title: str, message: str) -> bool:
    try:
        from win10toast import ToastNotifier  # type: ignore
    except Exception:
        return False
    try:
        # threaded=False so the toast renders before this short-lived process exits.
        ToastNotifier().show_toast(title, message, duration=5, threaded=False)
        return True
    except Exception:
        return False


def _powershell_toast(title: str, message: str) -> bool:
    """Dependency-free Windows toast via WinRT through PowerShell.

    Title/message are passed as environment variables (not interpolated into the
    script) so there is no command/script injection regardless of their content.
    """
    ps = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $t.GetElementsByTagName('text')
[void]$texts.Item(0).AppendChild($t.CreateTextNode($env:NOTIFY_TITLE))
[void]$texts.Item(1).AppendChild($t.CreateTextNode($env:NOTIFY_MESSAGE))
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:NOTIFY_APPID)
$notifier.Show($toast)
"""
    env = {
        **os.environ,
        "NOTIFY_TITLE": title,
        "NOTIFY_MESSAGE": message,
        "NOTIFY_APPID": APP_ID,
    }
    # CREATE_NO_WINDOW stops the PowerShell child from flashing a console window.
    no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
            env=env,
            check=True,
            capture_output=True,
            timeout=15,
            creationflags=no_window,
        )
        return True
    except Exception:
        return False


def notify(title: str, message: str) -> bool:
    for backend in (_win11toast, _win10toast, _powershell_toast):
        if backend(title, message):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Show a JobFinder desktop notification.")
    parser.add_argument("--title", default=APP_ID)
    parser.add_argument("--message", default="")
    args = parser.parse_args()

    if notify(args.title, args.message):
        return 0
    print("notify: all notification backends failed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
