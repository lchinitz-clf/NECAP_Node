# Matches the Node.js major version already running this app natively
# on the laptop (node --version reported 26.13.0). "slim" is a reduced
# Debian-based variant -- smaller than the full node image, but still
# glibc-based rather than Alpine's musl, which avoids a class of subtle
# native-module compatibility issues Alpine sometimes introduces. None
# of this app's dependencies (express, multer, mammoth, pdf-parse,
# exceljs, nodemailer, dotenv, turndown) need anything Alpine-specific,
# but "slim" is the safer default for a first Docker setup regardless.
FROM node:26-slim

# Everything from here on happens inside this folder, INSIDE the
# container's own filesystem (unrelated to any folder on your laptop
# with the same name) -- it's where the app's files will end up living
# once we copy them in, and where "npm install"/"node index.js" will
# actually run from.
WORKDIR /app

# Copies in ONLY the dependency manifest (package.json, plus
# package-lock.json if you have one -- the * covers either case) --
# not the rest of the app's code yet. Doing this as its own separate
# step is a deliberate, standard Docker trick: Docker caches the
# result of each instruction, so as long as these two files don't
# change, a later rebuild can skip re-running the install step
# entirely and reuse the cached result, even if your actual app code
# changed. We'll copy the real source code in afterward.
COPY package*.json ./

# Installs exactly the dependencies listed in package.json -- this is
# the step the previous COPY/caching trick is protecting. Your
# package.json has no devDependencies, so there's nothing extra to
# exclude here.
RUN npm install

# Now that dependencies are installed (and cached, per the trick
# above), copy in the rest of the actual application code: index.js,
# src/, public/, README.md, etc.
COPY . .

# Documents which port the app will listen on inside the container.
# The code's own built-in fallback is 3500 (process.env.PORT || 3500),
# but your host setup overrides that to 8080 via its own PORT
# environment variable -- for the container, we're deliberately
# choosing 3500 on purpose instead, specifically so the two are easy
# to tell apart while both might be running at once. This line alone
# doesn't actually make the port reachable from outside the container
# -- it's documentation/intent. Actually publishing it to the host,
# and setting PORT=3500 so the app really listens there, happens
# later, when we run the container.
EXPOSE 3500

# The command that actually runs when a container starts from this
# image -- everything above this line only happens once, at BUILD
# time; this line runs every time the container STARTS. Calling
# node directly on index.js (matching package.json's "main" and
# "start" script) rather than going through "npm start" is a small,
# deliberate choice: npm's own process sits between Docker and your
# actual app, and some npm versions don't forward the "please shut
# down" signal Docker sends (docker stop) cleanly through to the real
# node process underneath -- calling node directly avoids that
# question entirely.
CMD ["node", "index.js"]