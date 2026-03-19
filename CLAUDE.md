# RL Viewer - Claude Notes

## Network / VR Headset Access

The local LAN is 192.168.1.x. WSL2 gets a 172.25.82.x internal IP which is
not directly reachable from the LAN (e.g. Meta Quest headset).

To expose the Vite dev server (port 5173) on the Windows 192.168.1.x interface,
run this in an **Administrator PowerShell on Windows**:

```powershell
netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=172.25.82.244
netsh advfirewall firewall add rule name="WSL Vite 5173" dir=in action=allow protocol=TCP localport=5173
```

Then access the app on the headset at:
  https://<windows-192.168.1.x-ip>:5173

The Windows 192.168.1.x IP can be found with `ipconfig` in a Windows terminal
(look for the Wi-Fi adapter's IPv4 address).

To remove the rule when no longer needed:
```powershell
netsh interface portproxy delete v4tov4 listenport=5173 listenaddress=0.0.0.0
netsh advfirewall firewall delete rule name="WSL Vite 5173"
```

The WSL2 internal IP (172.25.82.244) can change on restart. If the headset
can no longer connect, re-run the portproxy add command with the new IP from
`ip addr show eth0` inside WSL.
