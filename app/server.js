const express = require("express");
const authMac = require("./auth/mac");
const path = require("path");
const db = require("./db");
const bcrypt = require("bcrypt");
const { snmp } = require('./snmp/main');
const { schedulePortAction } = require("./cron/portScheduler");
const { exec } = require("child_process");
const { snmpPooling } = require("./snmp/main");

function addCronjob(cronline) {
  return new Promise((resolve, reject) => {
    const command = `(crontab -l 2>/dev/null; echo "${cronline}") | crontab -`;
    exec(command, (error) => {
      if (error) return reject(error);
      resolve(true);
    });
  });
}


const app = express();
const PORT = 5500;

app.use(express.json());


// ========================================
// ROTAS DE PÁGINAS
// ========================================
app.get(`/`, async (req, res) => {

  const ip = req.socket.remoteAddress;
  const accepted = await authMac.verifyAdminMAC(ip);

  if (accepted) {
    res.sendFile(path.join(__dirname, "frontend", "pages", "index.html"));
  } else {
    res.status(403).sendFile(
      path.join(__dirname, 'frontend', 'pages', 'forbidden.html')
    );
  }

});

app.get('/main.html', async (req, res)=> {

  const ip = req.socket.remoteAddress;

  const accepted = await authMac.verifyAdminMAC(ip)

  if (accepted) {
    res.sendFile(
      path.join(__dirname, "frontend", "pages", "main.html")
    );
  } else {
    res.sendFile(
      path.join(__dirname, "frontend", "pages", "forbidden.html")
    );
  }

});


// ========================================
// LOGIN
// ========================================
app.post("/login.html", async (req, res) => {

  try {

    const { login, password } = req.body;

    const rows = await db.query(
      'SELECT id, login, "password" FROM admin_user WHERE login = $1',
      [login]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);

    if (!ok) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    res.status(200).sendFile(
      path.join(__dirname, 'frontend', 'pages', "main.html")
    );

  }
  catch (err) {

    console.error(err);

    res.status(500).json({ error: "Erro interno do servidor" });

  }

});


/* ===============================
   API - CONTROLE DE PORTAS
================================ */

// Lê estado do banco

app.get("/api/ports", async (req, res) => {
  try {
    const switchId = req.query.switch;

    // Buscar todos os switches corretamente (somente rows)
    const switches = await db.query('SELECT * FROM switch');

    // Filtrar caso venha ?switch=ID
    const filteredSwitches = switchId
      ? switches.filter(sw => sw.id === Number(switchId))
      : switches;

    const result = [];

    for (const sw of filteredSwitches) {

      // Sempre retorna array (mesmo se vazio)
      const portsRes = await db.query(
        "SELECT * FROM port WHERE switch_id = $1 AND number <= 24",
        [sw.id]
      );

      result.push({
        id: sw.id,
        name: sw.hostname,     // <-- o frontend espera "name"
        ipv4: sw.ipv4,
        ports: portsRes ?? []  // <-- garante que nunca será undefined
      });
    }

    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar portas" });
  }
});


app.post("/api/port/block", async (req, res) => {

  try {

    const { ip, ifIndex, duration } = req.body;

    if (!ip || !ifIndex || !duration) {
      return res.status(400).json({
        error: "ip, ifIndex e duration são obrigatórios"
      });
    }

    // 1️⃣ BLOQUEIO IMEDIATO (via Node)
    try {
      await schedulePortAction(
        ip,
        Number(ifIndex),
        "block"
      );
  } catch (snmpErr) {
      console.error("SNMP ERROR:", snmpErr.message);

      // continua, mas avisa que SNMP falhou
      return res.status(500).json({
          error: "Falha no SNMP ao bloquear",
          details: snmpErr.message
      });
  }


    // 2️⃣ AGENDA O DESBLOQUEIO NO CRON
    const script = path.resolve(__dirname, "portSchedulerCli.js");

    const unblockTime = new Date(Date.now() + Number(duration) * 1000);

    const minute = unblockTime.getMinutes();
    const hour = unblockTime.getHours();
    const day = unblockTime.getDate();
    const month = unblockTime.getMonth() + 1;

    // O cronjob que irá rodar futuramente:
    const cronLine =
`${minute} ${hour} ${day} ${month} * /usr/bin/node ${script} ${ip} ${ifIndex} unblock # auto-unblock`;

    await addCronjob(cronLine);

    return res.json({
      success: true,
      unblock_scheduled_for: unblockTime.toISOString(),
      cron: cronLine
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Erro ao bloquear porta",
      message: err.message
    });

  }
});


app.post("/api/port/unblock", async (req, res) => {

  try {

    const { ip, ifIndex } = req.body;

    if (!ip || !ifIndex) {
      return res.status(400).json({
        error: "ip e ifIndex são obrigatórios"
      });
    }

    await schedulePortAction(
      ip,
      Number(ifIndex),
      "unblock"
    );

    res.json({ success: true });

  }
  catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao desbloquear porta",
      message: err.message
    });

  }

});


app.use(express.static(path.join(__dirname, "frontend")));

app.listen(PORT, ()=>{
  console.log("Rodando em " + PORT);

  snmpPooling();
})
