const { blockPort, unblockPort, pollSingleInterface } = require('../snmp/main');


// evita duplicidade de agendamentos
const scheduledJobs = new Map();

/**
 *
 * @param {string} swIp           IP do switch
 * @param {number} ifIndex       Porta física
 * @param {"block"|"unblock"} action
 * @param {number|null} durationSeconds  tempo até o desbloqueio automático
 */
async function schedulePortAction(
  swIp,
  ifIndex,
  action,
  durationSeconds = null
) {

  const jobKey = `${swIp}:${ifIndex}`;

  // cancela agendamento anterior se houver
  if (scheduledJobs.has(jobKey)) {
    clearTimeout(scheduledJobs.get(jobKey));
    scheduledJobs.delete(jobKey);
  }

  // -------------------------------
  // DESBLOQUEIO IMEDIATO
  // -------------------------------
  if (action === "unblock") {

    console.log(`[UNBLOCK] ${jobKey}`);

    await unblockPort(swIp, ifIndex);

    await pollSingleInterface(swIp, ifIndex);

    return;
  }

  // -------------------------------
  // BLOQUEIO TEMPORIZADO
  // -------------------------------
  if (action === "block") {

    console.log(`[BLOCK] ${jobKey} por ${durationSeconds}s`);

    if (!durationSeconds || durationSeconds <= 0) {
      throw new Error("Tempo inválido para bloqueio temporizado");
    }

    // bloqueia agora
    await blockPort(swIp, ifIndex);
    await pollSingleInterface(swIp, ifIndex);

    // agenda desbloqueio
    const timer = setTimeout(async () => {

      try {
        console.log(`[AUTO-UNBLOCK] ${jobKey}`);

        await unblockPort(swIp, ifIndex);
        await pollSingleInterface(swIp, ifIndex);

      }
      catch (err) {
        console.error(`Erro no desbloqueio automático ${jobKey}`, err);
      }
      finally {
        scheduledJobs.delete(jobKey);
      }

    }, durationSeconds * 1000);

    scheduledJobs.set(jobKey, timer);

    return;
  }

  throw new Error(`Ação inválida: ${action}`);
}

module.exports = { schedulePortAction };
