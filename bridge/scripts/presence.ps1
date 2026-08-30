$ErrorActionPreference = 'Stop'

if (-not ('BridgeAgentPresence.NativeMethods' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;

namespace BridgeAgentPresence {
  public static class NativeMethods {
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO {
      public uint cbSize;
      public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll")]
    private static extern bool SwitchDesktop(IntPtr desktop);

    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);

    public static double IdleSeconds() {
      var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
      if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("GetLastInputInfo failed");
      uint elapsed = unchecked(GetTickCount() - info.dwTime);
      return elapsed / 1000.0;
    }

    public static bool IsLocked() {
      const uint DESKTOP_SWITCHDESKTOP = 0x0100;
      var desktop = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
      if (desktop == IntPtr.Zero) return true;
      try { return !SwitchDesktop(desktop); }
      finally { CloseDesktop(desktop); }
    }
  }
}
'@
}

[pscustomobject]@{
  idleSeconds = [Math]::Round([BridgeAgentPresence.NativeMethods]::IdleSeconds(), 3)
  sessionLocked = [BridgeAgentPresence.NativeMethods]::IsLocked()
  observedAt = [DateTimeOffset]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
