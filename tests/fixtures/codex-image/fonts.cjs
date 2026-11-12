// API-fixture-only offline font CSS. Explicit keys also work with Turbopack's
// serialized mocked responses (a Proxy does not). No external font is fetched.
module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100,900&display=swap": "@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; src: local('Arial'); }",
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap": "@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; src: local('Arial'); }",
};
