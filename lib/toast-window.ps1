# dsh-simple-notify - self-drawn overlay window.
#
# Why this exists instead of only using the shell toast (notify.ps1):
# Windows suppresses toast BANNERS while a fullscreen app is in front. The
# suppression is silent: ToastNotificationManager.Show() returns normally and
# the notification still lands in Action Center, but nothing is drawn. Verified
# on this machine via SHQueryUserNotificationState (5 = accepts, 2 = busy) and
# HKCU\...\Notifications\QuietHours\FullScreenProcess. A topmost window is not
# subject to that rule, so the plugin draws its own.
#
# This file is deliberately pure ASCII. PowerShell 5.1 decodes .ps1 files with
# the system ANSI code page, so any literal non-ASCII character would arrive
# corrupted. Text is passed in as Base64-encoded UTF-8 instead.
#
# Environment:
#   DSH_NOTIFY_TITLE_B64   Base64(UTF-8) heading
#   DSH_NOTIFY_BODY_B64    Base64(UTF-8) body (may be empty)
#   DSH_NOTIFY_HOLD_MS     how long to stay fully visible (default 4200)
#   DSH_NOTIFY_WIDTH       window width in device pixels (default 420)
#   DSH_NOTIFY_ACCENT      '#RRGGBB' accent bar colour (default '#4F8EF7')
#   DSH_NOTIFY_WINDOW_PID_RESOLVED
#                          validated DSH window process id; a click on the
#                          window focuses that process (set by notify.ps1)
#
# Behaviour notes:
#   * WS_EX_NOACTIVATE + ShowWithoutActivation keep keyboard focus where it was,
#     so the window cannot interrupt typing or a game.
#   * WS_EX_TOOLWINDOW keeps it out of the taskbar and Alt+Tab.
#   * Clicking it closes it and, when a window pid is known, brings DSH to the
#     front; it never takes input otherwise.
#   * The process exits by itself, so the plugin does not track it.

$ErrorActionPreference = 'Stop'

function Decode-B64Utf8([string] $value) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  $bytes = [System.Convert]::FromBase64String($value)
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

$title = Decode-B64Utf8 $env:DSH_NOTIFY_TITLE_B64
$body = Decode-B64Utf8 $env:DSH_NOTIFY_BODY_B64

$holdMs = 4200
if ($env:DSH_NOTIFY_HOLD_MS) {
  $parsed = 0
  if ([int]::TryParse($env:DSH_NOTIFY_HOLD_MS, [ref]$parsed) -and $parsed -ge 800) { $holdMs = $parsed }
}

$width = 420
if ($env:DSH_NOTIFY_WIDTH) {
  $parsed = 0
  if ([int]::TryParse($env:DSH_NOTIFY_WIDTH, [ref]$parsed) -and $parsed -ge 240 -and $parsed -le 900) { $width = $parsed }
}

$accent = '#4F8EF7'
if ($env:DSH_NOTIFY_ACCENT -match '^#[0-9A-Fa-f]{6}$') { $accent = $env:DSH_NOTIFY_ACCENT }

if ([string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($body)) {
  Write-Output 'skipped (no text)'
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DshToastWindow : Form
{
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    private readonly string _title;
    private readonly string _body;
    private readonly Color _accent;
    private readonly int _holdMs;
    private readonly Timer _timer;
    private DateTime _shownAt;
    private bool _fading;

    /// <summary>
    /// How the last click resolved. Filled in by OnClick and handed back to
    /// PowerShell after the message loop returns: the window is a compiled type
    /// and cannot call Write-Output, but the caller can still report the
    /// outcome, which is what makes a failed focus visible in the log instead
    /// of looking like a click that did nothing.
    /// </summary>
    public string FocusOutcome;
    private string _focusOutcome;

    /// <summary>
    /// Callback into the PowerShell side that focuses the DSH window. The
    /// containing assembly is compiled by Add-Type, so it cannot reference a
    /// PowerShell function directly; a scriptblock passed as a delegate is the
    /// supported bridge. A null value means "not clickable".
    /// </summary>
    public Func<int, string> FocusAction;

    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_TOPMOST = 0x00000008;

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
            return cp;
        }
    }

    public DshToastWindow(string title, string body, Color accent, int holdMs)
    {
        _title = title ?? "";
        _body = body ?? "";
        _accent = accent;
        _holdMs = holdMs;

        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        DoubleBuffered = true;
        BackColor = Color.FromArgb(28, 30, 34);
        Opacity = 0.0;

        // Measure first, then size the window to the text.
        int pad = 18;
        int accentBar = 4;
        Font titleFont = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold, GraphicsUnit.Point);
        Font bodyFont = new Font("Microsoft YaHei UI", 10f, FontStyle.Regular, GraphicsUnit.Point);

        int textWidth = 420 - pad * 2 - accentBar;
        int titleHeight = 0;
        int bodyHeight = 0;

        using (Graphics g = CreateGraphics())
        {
            if (_title.Length > 0)
            {
                SizeF s = g.MeasureString(_title, titleFont, textWidth);
                titleHeight = (int)Math.Ceiling(s.Height);
            }
            if (_body.Length > 0)
            {
                SizeF s = g.MeasureString(_body, bodyFont, textWidth);
                bodyHeight = (int)Math.Ceiling(s.Height);
            }
        }

        int height = pad * 2 + accentBar;
        if (titleHeight > 0) height += titleHeight + 4;
        if (bodyHeight > 0) height += bodyHeight + (titleHeight > 0 ? 6 : 0);
        if (height < 64) height = 64;

        // DPI-aware placement: WorkingArea is already in device pixels once the
        // process is marked DPI aware.
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        int margin = 24;
        Width = 420;
        Height = height;
        Left = wa.Right - Width - margin;
        Top = wa.Bottom - Height - margin;

        _timer = new Timer();
        _timer.Interval = 40;
        _timer.Tick += OnTick;
        _shownAt = DateTime.UtcNow;
    }

    private void OnTick(object sender, EventArgs e)
    {
        double elapsed = (DateTime.UtcNow - _shownAt).TotalMilliseconds;

        if (!_fading)
        {
            if (Opacity < 1.0)
            {
                Opacity = Math.Min(1.0, Opacity + 0.18);
            }
            if (elapsed > _holdMs)
            {
                _fading = true;
            }
            return;
        }

        Opacity -= 0.12;
        if (Opacity <= 0.02)
        {
            _timer.Stop();
            Close();
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _shownAt = DateTime.UtcNow;
        _timer.Start();
    }

    protected override void OnClick(EventArgs e)
    {
        base.OnClick(e);
        _timer.Stop();

        // A click means "take me to the app", so the window goes away first:
        // focusing DSH while our own topmost window is still up would leave it
        // covering the app the user just asked for.
        Close();

        int pid = 0;
        string raw = Environment.GetEnvironmentVariable("DSH_NOTIFY_WINDOW_PID_RESOLVED");
        if (string.IsNullOrEmpty(raw) || !int.TryParse(raw, out pid) || pid <= 0)
        {
            // No window to focus (a background job, or focus was not requested).
            // Closing is the whole response in that case.
            return;
        }

        if (FocusAction == null)
        {
            // A stand-alone run has no helper bound; the bubble still works.
            return;
        }

        // The helper is a PowerShell function, so an exception on that side
        // arrives wrapped in a MethodInvocationException; the inner message is
        // the one worth logging.
        try
        {
            string result = FocusAction(pid);
            _focusOutcome = string.IsNullOrEmpty(result) ? "click focus: (no answer)" : ("click focus: " + result);
        }
        catch (Exception ex)
        {
            Exception inner = ex.InnerException ?? ex;
            _focusOutcome = "click focus failed: " + inner.Message;
        }

        FocusOutcome = _focusOutcome;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        Rectangle full = new Rectangle(0, 0, Width, Height);
        using (GraphicsPath path = Rounded(full, 10))
        using (SolidBrush back = new SolidBrush(Color.FromArgb(238, 28, 30, 34)))
        {
            g.FillPath(back, path);
        }

        // Accent bar down the left edge, clipped to the rounded corner.
        using (GraphicsPath clip = Rounded(full, 10))
        {
            g.SetClip(clip);
            using (SolidBrush bar = new SolidBrush(_accent))
            {
                g.FillRectangle(bar, 0, 0, 4, Height);
            }
            g.ResetClip();
        }

        int pad = 18;
        int left = pad + 4;
        int y = pad;
        int textWidth = Width - left - pad;

        if (_title.Length > 0)
        {
            using (Font f = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold, GraphicsUnit.Point))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(245, 246, 248)))
            {
                SizeF s = g.MeasureString(_title, f, textWidth);
                g.DrawString(_title, f, b, new RectangleF(left, y, textWidth, s.Height));
                y += (int)Math.Ceiling(s.Height) + 4;
            }
        }

        if (_body.Length > 0)
        {
            if (_title.Length > 0) y += 2;
            using (Font f = new Font("Microsoft YaHei UI", 10f, FontStyle.Regular, GraphicsUnit.Point))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(196, 200, 208)))
            {
                g.DrawString(_body, f, b, new RectangleF(left, y, textWidth, Height - y - pad));
            }
        }
    }

    private static GraphicsPath Rounded(Rectangle r, int radius)
    {
        GraphicsPath p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static string ShowToast(string title, string body, string accentHex, int holdMs, Func<int, string> focusAction)
    {
        try { SetProcessDPIAware(); } catch { }

        Color accent = Color.FromArgb(79, 142, 247);
        try
        {
            if (!string.IsNullOrEmpty(accentHex) && accentHex.Length == 7 && accentHex[0] == '#')
            {
                accent = Color.FromArgb(
                    Convert.ToInt32(accentHex.Substring(1, 2), 16),
                    Convert.ToInt32(accentHex.Substring(3, 2), 16),
                    Convert.ToInt32(accentHex.Substring(5, 2), 16));
            }
        }
        catch { }

        Application.EnableVisualStyles();
        DshToastWindow w = new DshToastWindow(title, body, accent, holdMs);
        w.FocusAction = focusAction;
        Application.Run(w);
        return w.FocusOutcome;
    }
}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop

# Plays the standard notification chime in this process. Used because the toast
# path cannot run while a fullscreen app owns the screen: Windows suppresses the
# whole toast (banner AND sound) in QUNS_BUSY, so we draw our own window and have
# to make the noise ourselves. Deliberately not [Console]::Beep - that is a raw
# square-wave beep from the motherboard, not the sound the user configured.
function Play-NotificationSound {
  if ($env:DSH_NOTIFY_SILENT -eq '1') { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Media.SystemSounds]::Asterisk.Play()
  } catch {
    # Never let a missing sound break the toast itself.
  }
}

# Hand the focus helper to the click handler. The compiled window cannot call a
# PowerShell function, but a scriptblock converts to Func<int,string>, which the
# window invokes on click. Stand-alone use (notify.ps1 absent) leaves the
# callback null, i.e. a bubble that closes on click and focuses nothing.
$focusAction = $null
$focusCommand = Get-Command Focus-DshWindow -CommandType Function -ErrorAction SilentlyContinue
if ($null -ne $focusCommand) {
  $focusAction = [Func[int, string]] $focusCommand.ScriptBlock
}

Play-NotificationSound

$outcome = [DshToastWindow]::ShowToast($title, $body, $accent, $holdMs, $focusAction)
if ($outcome) { Write-Output $outcome }
Write-Output 'shown'
