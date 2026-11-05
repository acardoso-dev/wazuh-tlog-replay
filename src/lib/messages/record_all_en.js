'use strict';

// O comando tlog-record-all é um arquivo pronto, instalado pelo script. Em inglês, estas mensagens
// são trocadas ao gerar o script. Sem apóstrofos: vários textos ficam entre aspas simples no shell.
module.exports = [
  ['ERRO: %s', 'ERROR: %s'],
  ['Rode com sudo.', 'Run with sudo.'],
  ['Não foi possível mudar o shell de $1.', 'Could not change the shell of $1.'],
  ['Nenhum usuário de emergência definido. Nada foi alterado.', 'No emergency user is defined. Nothing was changed.'],
  ['$RECORDER não encontrado. Nada foi alterado.', '$RECORDER not found. Nothing was changed.'],
  ['Gravação ativada para o usuário $user', 'Recording enabled for user $user'],
  ['Gravação ativada: %s', 'Recording enabled: %s'],
  ['Informe ao menos um usuário de emergência, que continuará sem gravação.', 'Provide at least one emergency user, who will not be recorded.'],
  ['O usuário de emergência $user não existe nesta máquina. Crie-o antes.', 'Emergency user $user does not exist on this machine. Create it first.'],
  ['O usuário $user já é gravado. Volte o shell dele antes de usá-lo como emergência.', 'User $user is already recorded. Restore their shell before using them as an emergency user.'],
  ['Ao menos um usuário de emergência precisa ter senha e estar no grupo sudo, ou ninguém conseguiria desfazer isto.', 'At least one emergency user must have a password and be in the sudo group, or nobody could undo this.'],
  ['Pronto. Usuários locais criados daqui em diante também serão gravados.', 'Done. Local users created from now on will also be recorded.'],
  ['Gravar todos: %s', 'Record all: %s'],
  ['FORA DA GRAVAÇÃO (conta de sistema)   %s', 'NOT RECORDED (system account)   %s'],
  ['gravado        %s', 'recorded       %s'],
  ['emergência     %s', 'emergency      %s'],
  ['SEM GRAVAÇÃO   %s', 'NOT RECORDED   %s'],
  ['sem login      %s', 'no login       %s'],
  ['Shell restaurado: %s (%s)', 'Shell restored: %s (%s)'],
  ['Gravação de todos desligada.', 'Recording of all users is off.'],
  ['Uso: tlog-record-all enable USUARIO... | sync | status | disable', 'Usage: tlog-record-all enable USER... | sync | status | disable'],
];
