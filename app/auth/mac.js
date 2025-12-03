const arp = require("node-arp");
const ping = require("ping");
const db = require("../db");

/**
 * Obtém o MAC usando node-arp.
 * Força um ping antes para garantir que a tabela ARP esteja populada.
 */
async function getMAC(ip){
    try {
        // dispara ICMP pra criar entrada ARP
        await ping.promise.probe(ip, { timeout: 2 });

        return await new Promise((resolve, reject) => {
            arp.getMAC(ip, (err, mac) => {
                if (err || !mac) {
                    console.error("Erro ao obter MAC:", err);
                    resolve(null);
                } else {
                    resolve(mac.toLowerCase());
                }
            });
        });

    } catch(err){
        console.error("Falha no getMAC:", err);
        return null;
    }
}

/**
 * Verifica se o MAC do IP bate com o MAC cadastrado no banco
 */
async function verifyAdminMAC(ip) {

    // Busca MAC esperado no banco
    const row = await db.query("SELECT mac FROM admin_user WHERE id = 1;");
    const macBanco = row[0]?.mac?.toLowerCase() ?? null;

    // console.log("MAC Banco:", macBanco);

    // TODO: Ativar o getMac

    // Obtém MAC do IP real
    // const macEncontrado = await getMAC(ip);

    const macEncontrado = '00:aa:06:00:00:01'

    // console.log("MAC Encontrado:", macEncontrado);

    if (!macEncontrado || !macBanco)
        return false;

    return macEncontrado === macBanco;
}

module.exports = {
    verifyAdminMAC
};
