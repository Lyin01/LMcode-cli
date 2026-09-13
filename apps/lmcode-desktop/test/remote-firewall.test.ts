import { describe, expect, it } from 'vitest'
import {
  buildFirewallRepairLaunchScript,
  buildFirewallRepairScript,
  buildFirewallStatusScript,
  isProgramCoveredByFirewallRules,
  parseFirewallProgramList,
  REMOTE_FIREWALL_RULE_NAME,
} from '../src/main/remote/firewall'

describe('firewall rule scripts', () => {
  it('queries the rule by display name', () => {
    const script = buildFirewallStatusScript(REMOTE_FIREWALL_RULE_NAME)
    expect(script).toContain(`DisplayName '${REMOTE_FIREWALL_RULE_NAME}'`)
    expect(script).toContain('Get-NetFirewallApplicationFilter')
  })

  it('escapes quotes in the rule name', () => {
    const script = buildFirewallStatusScript("Bob's rule")
    expect(script).toContain("'Bob''s rule'")
  })

  it('repair script removes stale rules before adding the scoped allow rule', () => {
    const script = buildFirewallRepairScript(REMOTE_FIREWALL_RULE_NAME, 'C:\\Apps\\LMCODE.exe')
    expect(script).toContain('Remove-NetFirewallRule')
    expect(script).toContain("Program 'C:\\Apps\\LMCODE.exe'")
    expect(script).toContain('-Direction Inbound')
    expect(script).toContain('-Action Allow')
    expect(script).toContain('-RemoteAddress LocalSubnet')
    expect(script.indexOf('Remove-NetFirewallRule')).toBeLessThan(
      script.indexOf('New-NetFirewallRule'),
    )
  })

  it('repair launch goes through UAC and passes the inner script base64-encoded', () => {
    const launch = buildFirewallRepairLaunchScript(REMOTE_FIREWALL_RULE_NAME, "C:\\O'Brien\\LMCODE.exe")
    expect(launch).toContain('-Verb RunAs')
    expect(launch).toContain('ToBase64String')
    expect(launch).toContain('-EncodedCommand')
    // The path is escaped once inside the inner script and once again when
    // that script is embedded as a literal in the outer one.
    expect(launch).toContain("C:\\O''''Brien\\LMCODE.exe")
  })
})

describe('firewall rule output parsing', () => {
  it('drops blank lines and trims', () => {
    expect(parseFirewallProgramList('  C:\\a.exe \r\n\r\nC:\\b.exe\n')).toEqual([
      'C:\\a.exe',
      'C:\\b.exe',
    ])
  })

  it('matches the executable case- and separator-insensitively', () => {
    const programs = ['c:/apps/LMCode.exe', 'C:\\Other\\thing.exe']
    expect(isProgramCoveredByFirewallRules(programs, 'C:\\Apps\\lmcode.exe')).toBe(true)
    expect(isProgramCoveredByFirewallRules(programs, 'C:\\Apps\\missing.exe')).toBe(false)
    expect(isProgramCoveredByFirewallRules([], 'C:\\Apps\\lmcode.exe')).toBe(false)
  })
})
