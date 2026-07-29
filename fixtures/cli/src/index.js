const args = process.argv.slice(2);
const flags = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--name" && i + 1 < args.length) {
    flags.name = args[i + 1];
    i++;
  }
}

if (flags.name) {
  console.log(`Hello, ${flags.name}!`);
} else {
  console.log("Usage: node src/index.js --name <your-name>");
}
