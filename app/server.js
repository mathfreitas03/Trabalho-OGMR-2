const express = require("express");
const authMac = require("./auth/mac");
const path = require("path");
const db = require("./db");
const bcrypt = require("bcrypt");

const { schedulePortAction } = require("./portScheduler");

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

app.post("/api/port/block", async (req, res) => {

  try {

    const { ip, ifIndex, duration } = req.body;

    if (!ip || !ifIndex || !duration) {
      return res.status(400).json({
        error: "ip, ifIndex e duration são obrigatórios"
      });
    }

    await schedulePortAction(
      ip,
      Number(ifIndex),
      "block",
      Number(duration)
    );

    res.json({ success: true });

  }
  catch (err) {

    console.error(err);

    res.status(500).json({
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
});
