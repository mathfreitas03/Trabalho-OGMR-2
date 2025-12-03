const { schedulePortAction } = require("./portScheduler");

const [
  ,
  ,
  ip,
  ifIndex,
  action,
  duration
] = process.argv;

schedulePortAction(
  ip,
  Number(ifIndex),
  action,
  duration ? Number(duration) : null
)
.then(() => process.exit(0))
.catch(err => {
  console.error(err);
  process.exit(1);
});
