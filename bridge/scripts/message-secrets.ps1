[CmdletBinding()]
param(
  [ValidateSet('Provision', 'ConfigureConnectorTokens', 'SyncCloudflare', 'Status', 'VerifyOnline', 'VerifyQueue', 'CopyAdminPassword', 'RunRelay', 'SyncConversationProfile')]
  [string]$Action = 'Status',
  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'MessageCenter\secrets.dpapi.json'),
  [string]$WorkerProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\cloudflare-worker')),
  [string]$RelayProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')),
  [string]$MessageUrl = $(if ($env:BRIDGE_MESSAGE_URL) { $env:BRIDGE_MESSAGE_URL } else { 'https://message.example.com' }),
  [switch]$ForceRotate,
  [string[]]$ConnectorTokenIds = @(),
  [string]$ConnectorId,
  [string]$ConversationExternalId,
  [string]$ConversationDisplayName,
  [string]$AvatarPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Entropy = [Text.Encoding]::UTF8.GetBytes('message-center/local-secrets/v1')
$script:RequiredNames = @('CONNECTOR_TOKEN', 'AGENT_TOKEN', 'ADMIN_TOKEN')

function Set-PrivateAcl {
  param(
    [Parameter(Mandatory)] [string]$LiteralPath,
    [Parameter(Mandatory)] [bool]$IsDirectory
  )

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  # Build a DACL-only descriptor. Reusing Get-Acl can carry an existing SACL into
  # Set-Acl, which requires SeSecurityPrivilege even though this function only
  # intends to restrict ordinary file access.
  $acl = if ($IsDirectory) {
    [Security.AccessControl.DirectorySecurity]::new()
  } else {
    [Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)

  if ($IsDirectory) {
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
  } else {
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    $propagation = [Security.AccessControl.PropagationFlags]::None
  }

  foreach ($sid in @($currentSid, $systemSid)) {
    $accessRule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($accessRule)
  }
  if ($IsDirectory) {
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($LiteralPath), $acl)
  } else {
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($LiteralPath), $acl)
  }
}

function New-MessageToken {
  $bytes = [byte[]]::new(48)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  try {
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Write-ProtectedSecrets {
  param([Parameter(Mandatory)] [hashtable]$Values)

  $directory = Split-Path -Parent $SecretPath
  if (-not (Test-Path -LiteralPath $directory)) {
    [void][IO.Directory]::CreateDirectory($directory)
  }
  Set-PrivateAcl -LiteralPath $directory -IsDirectory $true

  $plainJson = $Values | ConvertTo-Json -Compress
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainJson)
  $cipherBytes = $null
  try {
    $cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $script:Entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $envelope = [ordered]@{
      version = 1
      scheme = 'DPAPI-CurrentUser'
      createdAt = [DateTimeOffset]::UtcNow.ToString('o')
      ciphertext = [Convert]::ToBase64String($cipherBytes)
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($SecretPath, $envelope, [Text.UTF8Encoding]::new($false))
    Set-PrivateAcl -LiteralPath $SecretPath -IsDirectory $false
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    if ($null -ne $cipherBytes) {
      [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
    }
  }
}

function Read-ProtectedSecrets {
  if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
    throw "Local secret store not found: $SecretPath"
  }
  $envelope = [IO.File]::ReadAllText($SecretPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($envelope.version -ne 1 -or $envelope.scheme -ne 'DPAPI-CurrentUser') {
    throw 'Unsupported local secret store format.'
  }

  $cipherBytes = [Convert]::FromBase64String([string]$envelope.ciphertext)
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $cipherBytes,
    $script:Entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    $values = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json -AsHashtable
    foreach ($name in $script:RequiredNames) {
      if (-not $values.ContainsKey($name) -or [string]$values[$name].Length -lt 32) {
        throw "Secret store is missing a valid $name."
      }
    }
    if ($values.ContainsKey('CONNECTOR_TOKENS')) {
      [void](Get-ConnectorTokenMap -Values $values)
    }
    return $values
  } finally {
    [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}

function Get-ConnectorTokenMap {
  param(
    [Parameter(Mandatory)] [hashtable]$Values,
    [switch]$AllowMissing
  )

  if (-not $Values.ContainsKey('CONNECTOR_TOKENS')) {
    if ($AllowMissing) { return $null }
    throw 'The protected secret store does not contain CONNECTOR_TOKENS.'
  }
  $tokens = $Values.CONNECTOR_TOKENS
  if (-not ($tokens -is [Collections.IDictionary]) -or $tokens.Count -lt 1) {
    throw 'CONNECTOR_TOKENS must be a non-empty connector ID to token map.'
  }
  $uniqueTokens = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $tokens.GetEnumerator()) {
    $id = [string]$entry.Key
    $token = [string]$entry.Value
    if ($id -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$' -or
        $token.Length -lt 32 -or $token.Length -gt 4096 -or $token -match '\s' -or
        -not $uniqueTokens.Add($token)) {
      throw 'CONNECTOR_TOKENS contains an invalid connector ID or token.'
    }
  }
  return $tokens
}

function Get-ConnectorCredential {
  param(
    [Parameter(Mandatory)] [hashtable]$Values,
    [string]$Id
  )

  $tokens = Get-ConnectorTokenMap -Values $Values -AllowMissing
  if ($null -eq $tokens) { return [string]$Values.CONNECTOR_TOKEN }
  if ([string]::IsNullOrWhiteSpace($Id) -or -not $tokens.Contains($Id)) {
    throw 'A configured CONNECTOR_TOKENS map requires an exact ConnectorId.'
  }
  return [string]$tokens[$Id]
}

function ConvertTo-ConnectorTokensJson {
  param([Parameter(Mandatory)] [Collections.IDictionary]$Tokens)
  return $Tokens | ConvertTo-Json -Depth 3 -Compress
}

function Invoke-WranglerSecretPut {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$Value
  )

  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $configPath = Join-Path $WorkerProject 'wrangler.jsonc'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Worker configuration not found: $configPath"
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $npx
  $startInfo.WorkingDirectory = $WorkerProject
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @('wrangler', 'secret', 'put', $Name, '--config', $configPath)) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.StandardInput.WriteLine($Value)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "Wrangler failed while setting $Name (exit code $($process.ExitCode)); command output was suppressed to protect secret material."
  }
  Write-Output "Uploaded Cloudflare secret: $Name"
}

function Sync-CloudflareSecrets {
  param([Parameter(Mandatory)] [hashtable]$Values)
  foreach ($name in $script:RequiredNames) {
    Invoke-WranglerSecretPut -Name $name -Value ([string]$Values[$name])
  }
  $connectorTokens = Get-ConnectorTokenMap -Values $Values -AllowMissing
  if ($null -ne $connectorTokens) {
    Invoke-WranglerSecretPut -Name 'CONNECTOR_TOKENS' -Value (ConvertTo-ConnectorTokensJson -Tokens $connectorTokens)
  }
}

function Configure-ConnectorTokens {
  param(
    [Parameter(Mandatory)] [hashtable]$Values,
    [Parameter(Mandatory)] [string[]]$Ids,
    [switch]$Rotate
  )

  if ($Ids.Count -lt 1) {
    throw 'ConfigureConnectorTokens requires at least one -ConnectorTokenIds value.'
  }
  $tokens = @{}
  $existing = Get-ConnectorTokenMap -Values $Values -AllowMissing
  if ($null -ne $existing) {
    foreach ($entry in $existing.GetEnumerator()) {
      $tokens[[string]$entry.Key] = [string]$entry.Value
    }
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($candidate in $Ids) {
    $id = [string]$candidate
    if ($id -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$' -or -not $seen.Add($id)) {
      throw 'ConnectorTokenIds contains an invalid or duplicate connector ID.'
    }
    if ($Rotate -or -not $tokens.ContainsKey($id)) {
      do { $newToken = New-MessageToken } while ($tokens.ContainsValue($newToken))
      $tokens[$id] = $newToken
    }
  }
  $Values['CONNECTOR_TOKENS'] = $tokens
  Write-ProtectedSecrets -Values $Values
  Invoke-WranglerSecretPut -Name 'CONNECTOR_TOKENS' -Value (ConvertTo-ConnectorTokensJson -Tokens $tokens)
  Write-Output "Connector token map stored with DPAPI and uploaded; configured instances=$($tokens.Count)."
}

function Get-SecretFingerprint {
  param([Parameter(Mandatory)] [string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return ([Convert]::ToHexString($hash)).Substring(0, 12).ToLowerInvariant()
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Test-OnlineAccess {
  param([Parameter(Mandatory)] [hashtable]$Values)

  $baseUri = [Uri]$MessageUrl
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.CookieContainer = [Net.CookieContainer]::new()
  $client = [Net.Http.HttpClient]::new($handler)
  try {
    $loginPageResponse = $client.GetAsync([Uri]::new($baseUri, '/login')).GetAwaiter().GetResult()
    $loginPageText = $loginPageResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $csrfMatch = [Text.RegularExpressions.Regex]::Match($loginPageText, 'name="csrf" value="([^"]+)"')
    if (-not $loginPageResponse.IsSuccessStatusCode -or -not $csrfMatch.Success) {
      throw "Online login page did not provide a signed form token."
    }
    $loginFields = [Collections.Generic.Dictionary[string,string]]::new()
    $loginFields.Add('password', [string]$Values.ADMIN_TOKEN)
    $loginFields.Add('csrf', $csrfMatch.Groups[1].Value)
    $loginBody = [Net.Http.FormUrlEncodedContent]::new($loginFields)
    $loginResponse = $client.PostAsync([Uri]::new($baseUri, '/api/auth/login'), $loginBody).GetAwaiter().GetResult()
    if (-not $loginResponse.IsSuccessStatusCode -or $loginResponse.RequestMessage.RequestUri.AbsolutePath -ne '/app') {
      throw "Online password login failed with HTTP $([int]$loginResponse.StatusCode)."
    }

    $inboxResponse = $client.GetAsync([Uri]::new($baseUri, '/api/inbox')).GetAwaiter().GetResult()
    if (-not $inboxResponse.IsSuccessStatusCode) {
      throw "Online inbox verification failed with HTTP $([int]$inboxResponse.StatusCode)."
    }
    $inbox = $inboxResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    $connectorCount = @($inbox.connectors).Count
    $onlineConnectorCount = @($inbox.connectors | Where-Object state -eq 'online').Count
    $conversationCount = @($inbox.conversations).Count
    $detailMessageCount = 0
    if ($conversationCount -gt 0) {
      $conversationId = [Uri]::EscapeDataString([string]$inbox.conversations[0].id)
      $detailResponse = $client.GetAsync([Uri]::new($baseUri, "/api/inbox?conversationId=$conversationId")).GetAwaiter().GetResult()
      if (-not $detailResponse.IsSuccessStatusCode) {
        throw "Online conversation detail verification failed with HTTP $([int]$detailResponse.StatusCode)."
      }
      $detail = $detailResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
      if ([string]$detail.selectedConversationId -ne [string]$inbox.conversations[0].id) {
        throw "Online conversation detail selected the wrong conversation."
      }
      $detailMessageCount = @($detail.messages).Count
    }

    $backupResponse = $client.GetAsync([Uri]::new($baseUri, '/api/group-text-backups?limit=500')).GetAwaiter().GetResult()
    if (-not $backupResponse.IsSuccessStatusCode) {
      throw "Online backup verification failed with HTTP $([int]$backupResponse.StatusCode)."
    }
    $backup = $backupResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    $backupCount = @($backup.backups).Count

    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, [Uri]::new($baseUri, '/mcp'))
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Values.AGENT_TOKEN)
    $request.Content = [Net.Http.StringContent]::new(
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      [Text.Encoding]::UTF8,
      'application/json'
    )
    $mcpResponse = $client.SendAsync($request).GetAwaiter().GetResult()
    $mcpText = $mcpResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $mcpResponse.IsSuccessStatusCode -or $mcpText -notmatch '"listen_messages"') {
      throw "Online MCP verification failed with HTTP $([int]$mcpResponse.StatusCode)."
    }
    Write-Output "Online verification passed: password session, unified conversation detail, compatibility backup endpoint, and MCP listener are available; connectors=$connectorCount, online=$onlineConnectorCount, conversations=$conversationCount, selectedMessages=$detailMessageCount, normalizedBackgroundMessages=$backupCount."
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Sync-ConversationProfile {
  param([Parameter(Mandatory)] [hashtable]$Values)
  if ($ConnectorId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$' -or
      $ConversationExternalId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$' -or
      [string]::IsNullOrWhiteSpace($ConversationDisplayName) -or $ConversationDisplayName.Length -gt 200) {
    throw 'ConnectorId, ConversationExternalId, and ConversationDisplayName are required and invalid.'
  }
  $uri = "$($MessageUrl.TrimEnd('/'))/api/connectors/conversation-profiles/$([Uri]::EscapeDataString($ConversationExternalId))"
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Put, $uri)
  $client = [Net.Http.HttpClient]::new()
  $avatarBytes = $null
  try {
    $connectorCredential = Get-ConnectorCredential -Values $Values -Id $ConnectorId
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $connectorCredential)
    $request.Headers.Add('x-connector-id', $ConnectorId)
    $request.Headers.Add('x-conversation-display-name', [Uri]::EscapeDataString($ConversationDisplayName))
    if ($AvatarPath) {
      $resolvedAvatar = [IO.Path]::GetFullPath($AvatarPath)
      if (-not (Test-Path -LiteralPath $resolvedAvatar -PathType Leaf)) { throw 'AvatarPath is not a regular file.' }
      $avatarBytes = [IO.File]::ReadAllBytes($resolvedAvatar)
      if ($avatarBytes.Length -lt 1 -or $avatarBytes.Length -gt 2MB) { throw 'Avatar size is outside the allowed range.' }
      $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($avatarBytes)).ToLowerInvariant()
      $mimeType = if ($avatarBytes.Length -ge 8 -and $avatarBytes[0] -eq 0x89 -and $avatarBytes[1] -eq 0x50) { 'image/png' }
        elseif ($avatarBytes.Length -ge 3 -and $avatarBytes[0] -eq 0xff -and $avatarBytes[1] -eq 0xd8) { 'image/jpeg' }
        elseif ($avatarBytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($avatarBytes, 0, 4) -eq 'RIFF' -and [Text.Encoding]::ASCII.GetString($avatarBytes, 8, 4) -eq 'WEBP') { 'image/webp' }
        elseif ($avatarBytes.Length -ge 6 -and [Text.Encoding]::ASCII.GetString($avatarBytes, 0, 3) -eq 'GIF') { 'image/gif' }
        else { throw 'Avatar image format is not supported.' }
      $request.Content = [Net.Http.ByteArrayContent]::new($avatarBytes)
      $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new($mimeType)
      $request.Headers.Add('x-content-sha256', $digest)
    }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      $details = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      throw "Conversation profile sync failed with HTTP $([int]$response.StatusCode): $details"
    }
    Write-Output "Conversation profile synchronized: connector=$ConnectorId, conversation=$ConversationExternalId, avatar=$([bool]$AvatarPath)"
  } finally {
    if ($null -ne $avatarBytes) { [Array]::Clear($avatarBytes, 0, $avatarBytes.Length) }
    $request.Dispose()
    $client.Dispose()
  }
}

function Invoke-McpTool {
  param(
    [Parameter(Mandatory)] [hashtable]$Values,
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [hashtable]$Arguments
  )
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, "$($MessageUrl.TrimEnd('/'))/mcp")
  $client = [Net.Http.HttpClient]::new()
  try {
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Values.AGENT_TOKEN)
    $payload = @{ jsonrpc = '2.0'; id = 1; method = 'tools/call'; params = @{ name = $Name; arguments = $Arguments } } | ConvertTo-Json -Depth 8 -Compress
    $request.Content = [Net.Http.StringContent]::new($payload, [Text.Encoding]::UTF8, 'application/json')
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $result = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    $isErrorProperty = $result.result.PSObject.Properties['isError']
    if (-not $response.IsSuccessStatusCode -or ($null -ne $isErrorProperty -and [bool]$isErrorProperty.Value)) {
      throw "MCP tool $Name failed with HTTP $([int]$response.StatusCode)."
    }
    return $result.result.structuredContent
  } finally {
    $request.Dispose()
    $client.Dispose()
  }
}

function Test-ImmediateQueue {
  param([Parameter(Mandatory)] [hashtable]$Values)
  $consumerId = "queue-verification-$([Guid]::NewGuid().ToString('N'))"
  $otherConsumerId = "queue-racer-$([Guid]::NewGuid().ToString('N'))"
  $listen = Invoke-McpTool -Values $Values -Name 'listen_messages' -Arguments @{ consumerId = $consumerId; limit = 1 }
  if (-not $listen.available) {
    Write-Output 'Immediate queue verification passed: listener is non-mutating and the queue is currently empty.'
    return
  }
  $messageId = [string]$listen.candidates[0].messageId
  $claim = Invoke-McpTool -Values $Values -Name 'claim_message' -Arguments @{ consumerId = $consumerId; messageId = $messageId }
  if (-not $claim.acquired) {
    Write-Output "Immediate queue verification observed a real claim race: reason=$($claim.race.reason)."
    return
  }
  $leaseToken = [string]$claim.message.leaseToken
  try {
    $race = Invoke-McpTool -Values $Values -Name 'claim_message' -Arguments @{ consumerId = $otherConsumerId; messageId = $messageId }
    if ($race.acquired -or -not $race.race.wonByOtherConsumer -or $race.race.reason -ne 'lease_race_lost') {
      throw 'The competing claim did not return the expected structured race result.'
    }
  } finally {
    $consume = Invoke-McpTool -Values $Values -Name 'consume_message' -Arguments @{
      consumerId = $consumerId; messageId = $messageId; leaseToken = $leaseToken; outcome = 'retry'
    }
    if (-not $consume.consumed) { throw 'The verification lease could not be returned to the queue.' }
  }
  Write-Output 'Immediate queue verification passed: listen, atomic claim, race reporting, and retry consumption are working.'
}

switch ($Action) {
  'Provision' {
    if ((Test-Path -LiteralPath $SecretPath) -and -not $ForceRotate) {
      throw 'Local secret store already exists. Use SyncCloudflare, or explicitly pass -ForceRotate to replace all credentials.'
    }
    $values = @{}
    foreach ($name in $script:RequiredNames) {
      $values[$name] = New-MessageToken
    }
    Write-ProtectedSecrets -Values $values
    Sync-CloudflareSecrets -Values $values
    Write-Output "Local DPAPI store: $SecretPath"
    Write-Output 'Provisioning completed; no plaintext secret was printed or written to the project.'
  }
  'ConfigureConnectorTokens' {
    $values = Read-ProtectedSecrets
    Configure-ConnectorTokens -Values $values -Ids $ConnectorTokenIds -Rotate:$ForceRotate
  }
  'SyncCloudflare' {
    $values = Read-ProtectedSecrets
    Sync-CloudflareSecrets -Values $values
  }
  'Status' {
    $values = Read-ProtectedSecrets
    Write-Output "Local DPAPI store: $SecretPath"
    foreach ($name in $script:RequiredNames) {
      $value = [string]$values[$name]
      Write-Output ("{0}: present, length={1}, fingerprint={2}" -f $name, $value.Length, (Get-SecretFingerprint $value))
    }
    $connectorTokens = Get-ConnectorTokenMap -Values $values -AllowMissing
    if ($null -ne $connectorTokens) {
      Write-Output "CONNECTOR_TOKENS: present, configured instances=$($connectorTokens.Count); token values and fingerprints are suppressed."
    }
  }
  'VerifyOnline' {
    $values = Read-ProtectedSecrets
    Test-OnlineAccess -Values $values
  }
  'VerifyQueue' {
    $values = Read-ProtectedSecrets
    Test-ImmediateQueue -Values $values
  }
  'CopyAdminPassword' {
    $values = Read-ProtectedSecrets
    Set-Clipboard -Value ([string]$values.ADMIN_TOKEN)
    Write-Output 'Administrator password copied to the Windows clipboard; no plaintext was printed.'
  }
  'RunRelay' {
    $values = Read-ProtectedSecrets
    $previousToken = $env:BRIDGE_MESSAGE_CONNECTOR_TOKEN
    $previousTokenMap = $env:BRIDGE_MESSAGE_CONNECTOR_TOKENS
    try {
      $connectorTokens = Get-ConnectorTokenMap -Values $values -AllowMissing
      if ($null -ne $connectorTokens) {
        $env:BRIDGE_MESSAGE_CONNECTOR_TOKENS = ConvertTo-ConnectorTokensJson -Tokens $connectorTokens
        $env:BRIDGE_MESSAGE_CONNECTOR_TOKEN = $null
      } else {
        $env:BRIDGE_MESSAGE_CONNECTOR_TOKENS = $null
        $env:BRIDGE_MESSAGE_CONNECTOR_TOKEN = [string]$values.CONNECTOR_TOKEN
      }
      Push-Location -LiteralPath $RelayProject
      try {
        & npm.cmd run unified-relay
        if ($LASTEXITCODE -ne 0) {
          throw "Relay exited with code $LASTEXITCODE."
        }
      } finally {
        Pop-Location
      }
    } finally {
      $env:BRIDGE_MESSAGE_CONNECTOR_TOKEN = $previousToken
      $env:BRIDGE_MESSAGE_CONNECTOR_TOKENS = $previousTokenMap
    }
  }
  'SyncConversationProfile' {
    $values = Read-ProtectedSecrets
    Sync-ConversationProfile -Values $values
  }
}
