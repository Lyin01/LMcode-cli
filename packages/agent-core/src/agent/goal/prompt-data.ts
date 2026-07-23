export type GoalPromptDataKind =
  | 'objective'
  | 'completion_criterion'
  | 'terminal_reason'
  | 'acceptance_criteria'
  | 'execution_evidence'
  | 'reviewer_feedback';

export function wrapUntrustedGoalData(kind: GoalPromptDataKind, value: string): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<untrusted_${kind}>\n${escaped}\n</untrusted_${kind}>`;
}
