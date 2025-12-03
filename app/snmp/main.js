const snmp = require('net-snmp')
const db = require ('../db')

const COMMUNITY = "private";

// OIDs
const OIDS = {
  ifIndex:       "1.3.6.1.2.1.2.2.1.1", // Identificador único da interface dentro do switch.
  ifDescr:       "1.3.6.1.2.1.2.2.1.2", // Nome textual da interface
  ifType:        "1.3.6.1.2.1.2.2.1.3", // Tipo da interface segundo classificação SNMP. Portas Ethernet físicas → ethernetCsmacd (6)
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7", // variável usada para bloquear/desbloquear portas.
  ifOperStatus:  "1.3.6.1.2.1.2.2.1.8", // status real de operação
  fdbMac:  "1.3.6.1.2.1.17.4.3.1.1", // retorna os endereços MAC aprendidos pelo switch na tabela de bridge 
  fdbPort: "1.3.6.1.2.1.17.4.3.1.2", // Informa em qual bridge port cada MAC foi aprendido (não é a porta física ainda).
  bridgeToIfIndex: "1.3.6.1.2.1.17.1.4.1.2" // Traduz o índice usado na tabela MAC para o índice real da porta física.
};

async function resolveIpFromMac(mac) {

  try {
    const ip = await getIpByMac(mac);
    return ip || null;
  }
  catch {
    return null;
  }

}

async function getSwitches() {
  const res = await db.query('SELECT * FROM switch');
  return res
}

function walk(session, oid) {
  return new Promise((resolve, reject) => {

    const data = [];

    session.walk(
      oid,
      20,
      vb => data.push(vb),
      err => err ? reject(err) : resolve(data)
    );
  });
}

async function loadMacPerPort(session) {

  const [macs, ports, bridgeMap] = await Promise.all([
    walk(session, OIDS.fdbMac),
    walk(session, OIDS.fdbPort),
    walk(session, OIDS.bridgeToIfIndex)
  ]);

  const macByBridge = {};

  for (let i = 0; i < macs.length; i++) {

    const mac = macs[i].value.toString('hex').match(/.{1,2}/g).join(':');

    const bridgePort = ports[i].value;
    macByBridge[bridgePort] ??= [];
    macByBridge[bridgePort].push(mac);
  }

  const ifIndexByBridge = {};

  for (const vb of bridgeMap) {
    const bridgePort = vb.oid.split('.').pop();
    ifIndexByBridge[bridgePort] = vb.value;
  }

  const result = {};

  for (const bridgePort in macByBridge) {
    const ifIndex = ifIndexByBridge[bridgePort];
    if (ifIndex) {
      result[ifIndex] = macByBridge[bridgePort];
    }
  }

  return result;

}

async function savePort(
  switchId,
  number,
  status,
  hostMac,
  hostIp,
  hostName
) {

  const q = `
    INSERT INTO port
      (switch_id, number, status, lockable, host_mac, host_ip, host_name)
    VALUES
      ($1,$2,$3,true,$4,$5,$6)
    ON CONFLICT (switch_id, number)
    DO UPDATE SET
      status = EXCLUDED.status,
      host_mac = EXCLUDED.host_mac,
      host_ip = EXCLUDED.host_ip,
      host_name = EXCLUDED.host_name;
  `;

  await db.query(q, [
    switchId,
    number,
    status,
    hostMac,
    hostIp,
    hostName
  ]);

}

async function scanAndPersistPorts() {

    console.log("Executando Pooling SNMP")

  const switches = await getSwitches();

  for (const sw of switches) {

    const session = snmp.createSession(sw.ipv4, COMMUNITY);

    try {

      // 1) Interfaces físicas
      const [ifIndexes, ifDescrs, ifTypes, ifOpers] = await Promise.all([
        walk(session, OIDS.ifIndex),
        walk(session, OIDS.ifDescr),
        walk(session, OIDS.ifType),
        walk(session, OIDS.ifOperStatus)
      ]);

      const ifaceMap = {};

      function fill(list, key) {
        for (const vb of list) {
          const idx = vb.oid.split('.').pop();
          ifaceMap[idx] ||= {};
          ifaceMap[idx][key] = vb.value;
        }
      }

      fill(ifIndexes, 'index');
      fill(ifDescrs,  'name');
      fill(ifTypes,   'type');
      fill(ifOpers,  'oper');

      // 2) MAC por porta
      const macByPort = await loadMacPerPort(session);

      // 3) Persistir
      console.log("Persistindo atualizações no banco de dados.")
      for (const iface of Object.values(ifaceMap)) {

        if (iface.type !== 6) continue; // só ethernet

        const ifIndex = iface.index;

        const status = iface.oper === 1;

        const macs = macByPort[ifIndex] || [];

        if (macs.length === 0) {
          await savePort(
            sw.id,
            ifIndex,
            status,
            null,
            null,
            null
          );
        }
        else {
          for (const mac of macs) {

            const ip = resolveIpFromMac[mac] || null;

            await savePort(
              sw.id,
              ifIndex,
              status,
              mac,
              ip,
              null
            );
          }
        }

      }

    }
    finally {
      session.close();
    }
  }

}

function snmpPooling (){
    setInterval(() => {
      scanAndPersistPorts();
    }, 30_000); // A cada 30 segundos atualiza o valor do banco.
}

async function blockPort(swIp, ifIndex) {

  const session = snmp.createSession(swIp, COMMUNITY_RW);

  return new Promise((res, rej) => {

    session.set([{
      oid: `1.3.6.1.2.1.2.2.1.7.${ifIndex}`,
      type: snmp.ObjectType.Integer,
      value: 2
    }], err => {

      session.close();

      if (err) return rej(err);

      res(true);

    });

  });

}

async function unblockPort(swIp, ifIndex) {

  const session = snmp.createSession(swIp, COMMUNITY_RW);

  return new Promise((res, rej) => {

    session.set([{
      oid: `1.3.6.1.2.1.2.2.1.7.${ifIndex}`,
      type: snmp.ObjectType.Integer,
      value: 1
    }], err => {

      session.close();

      if (err) return rej(err);

      res(true);

    });

  });

}

async function pollSingleInterface(ip, ifIndex) {

  const session = snmp.createSession(ip, COMMUNITY);

  try {

    // 1️⃣ Busca tipo e status da interface
    const oids = [
      `${OIDS.ifType}.${ifIndex}`,
      `${OIDS.ifAdminStatus}.${ifIndex}`,
      `${OIDS.ifOperStatus}.${ifIndex}`
    ];

    const iface = await new Promise((resolve, reject) => {

      session.get(oids, (err, vbs) => {

        if (err) return reject(err);

        resolve({
          type:  vbs[0].value,
          admin: vbs[1].value,
          oper:  vbs[2].value
        });

      });

    });

    // ignora interfaces não Ethernet
    if (iface.type !== 6) return;

    const status = iface.oper === 1;

    // 2️⃣ Resolve MAC da porta
    const macMap = await loadMacPerPort(session);

    const macs = macMap[ifIndex] || [];

    // 3️⃣ Busca ID do switch no banco
    const res = await db.query(
      "SELECT id FROM switch WHERE ipv4 = $1",
      [ip]
    );

    if (res.rowCount === 0) {
      throw new Error(`Switch não encontrado: ${ip}`);
    }

    const switchId = res.rows[0].id;

    // 4️⃣ Persistência

    if (macs.length === 0) {

      await savePort(
        switchId,
        ifIndex,
        status,
        null,
        null,
        null
      );

      return;

    }

    for (const mac of macs) {

      const hostIp = await resolveIp(mac);

      await savePort(
        switchId,
        ifIndex,
        status,
        mac,
        hostIp,
        null
      );

    }

  }
  finally {
    session.close();
  }

}

module.exports = {
  blockPort,
  unblockPort,
  pollSingleInterface,
  snmpPooling
};

// EXEMPLOS

// Exemplo que pega o tipo do hardware

// session.get(["1.3.6.1.2.1.1.1.0"], (err, vbs) => {
//   console.log(vbs[0].value.toString());
//   session.close();
// });


// Desliga porta com número iface.index

// session.set([{
//   oid: `1.3.6.1.2.1.2.2.1.7.${iface.index}`,
//   type: snmp.ObjectType.Integer,
//   value: 2
// }])


// Liga porta com número iface.index

// session.set([{
//   oid: `1.3.6.1.2.1.2.2.1.7.${iface.index}`,
//   type: snmp.ObjectType.Integer,
//   value: 1
// }])

