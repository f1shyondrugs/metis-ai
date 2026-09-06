# Remote-Client: Berechtigungsmodell

## Modi

- **Benutzerzugriff (Standard):** Per-User-Installation, nur Benutzerdateien, Benutzerprozesse und explizit erlaubte Benutzerverzeichnisse. Systemdateien, andere Profile, Dienste, Datenträger und administrative Befehle werden lokal und serverseitig abgewiesen.
- **Systemzugriff / Administrator:** Per-Machine-Installation mit UAC. Der Modus aktiviert keine pauschale Erhöhung: Nur registrierte Capabilities (`system_files`, `services`, `disks`, `admin_processes`) sind möglich; riskante Aktionen benötigen eine separate Bestätigung.

Der Modus wird beim Enrollment in `remote_clients.permission_mode` gespeichert, bei jedem Server-Tool-Aufruf geladen und im UI angezeigt. Die vom Client gemeldeten Capabilities erweitern diese Serverentscheidung nicht.

## Installation und Migration

Die Windows-Installation verwendet standardmäßig `%LOCALAPPDATA%\MetisAI\RemoteClient`. `-PermissionMode user` benötigt keine UAC-Abfrage. `-PermissionMode admin` startet sich mit `-Verb RunAs` neu und installiert nach `%ProgramFiles%\MetisAI\RemoteClient`.

Ein Wechsel von Benutzer- zu Administratorzugriff erfolgt ausschließlich über eine neue UAC-bestätigte Installation/Reparatur mit einem neuen Enrollment. Ein Wechsel zurück erfordert eine Per-User-Reparatur; privilegierte Komponenten müssen dabei entfernt bzw. deaktiviert werden. Bestehende Clients bleiben mit dem gespeicherten Modus kompatibel und werden bei fehlendem Feld als `user` migriert.

## Durchsetzung und Einschränkungen

Der Server prüft Modus, Capability, Allowlist, Pfad und riskante Befehle vor dem WebSocket-Aufruf. Der Client wiederholt die Pfad-/Befehlsprüfung mit den lokalen Benutzerverzeichnissen. Das ist eine Sicherheitsgrenze, aber kein Ersatz für Windows ACLs, AppLocker oder eine signierte native Sandbox. Die automatisierten Tests laufen auf Linux; ein echter Windows-UAC- und Per-Machine-Test ist in dieser Umgebung nicht möglich und wird nicht als erfolgreich behauptet.
