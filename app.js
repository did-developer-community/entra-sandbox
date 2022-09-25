'use strict';
///////////////////////////////////////////////////////////////////////////////////////
// Node packages
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const msal = require('@azure/msal-node');
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const bunyan = require('bunyan');
const log = bunyan.createLogger({
    name: 'VC Issuer Web Application'
});
const { auth, requiresAuth } = require('express-openid-connect');
var fetch = require( 'node-fetch' );

///////////////////////////////////////////////////////////////////////////////////////
// MSAL configuration for obtaining access_token to execute Entra Verified ID APIs
const msalConfig = {
  auth: {
      clientId: process.env.vcApp_client_id,
      authority: 'https://login.microsoftonline.com/' + process.env.vcApp_azTenantId,
      clientSecret: process.env.vcApp_client_secret,
  }
};
const cca = new msal.ConfidentialClientApplication(msalConfig);
const msalClientCredentialRequest = {
  scopes: [process.env.vcApp_scope],
  skipCache: false
};


///////////////////////////////////////////////////////////////////////////////////////
// Main Express server function
const app = express()
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(methodOverride());
app.use(cookieParser());
app.use(express.json())
app.use(express.urlencoded({ extended: true }));
app.use(express.static('views'));
app.use('/media', express.static('media'));
app.use('/lib', express.static('lib'));
const sessionStore = new session.MemoryStore();
app.use(session({
  secret: process.env.cookie_secret_key,
  resave: false,
  saveUninitialized: true,
  store: sessionStore
}))
app.use(
  auth({
    authRequired: false,
    baseURL: process.env.baseURL,
    clientID: process.env.oidc_auth_client_id,
    issuerBaseURL: process.env.oidc_auth_issuerBaseURL,
    secret: process.env.oidc_auth_secret
  })
);

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Serve index.html as the home page
app.get('/', function (req, res) {
  res.render('index');
})

///////////////////////////////////////////////////////////////////////////////////////
// Issuer
app.get('/issuer', requiresAuth(), function(req, res) {
  res.render('issuer', {
    name : req.oidc.user.name
  });
})

// issuance request
app.get('/api/issuer/issuance-request', async (req, res) => {

  var id = req.session.id;
  sessionStore.get( id, (error, session) => {
    var sessionData = {
      "status" : 0,
      "message": "Waiting for QR code to be scanned"
    };
    if ( session ) {
      session.sessionData = sessionData;
      sessionStore.set( id, session);  
    }
  });

  // get the Access Token to invoke issuance request API
  var accessToken = "";
  try {
    const result = await cca.acquireTokenByClientCredential(msalClientCredentialRequest);
    if ( result ) {
      accessToken = result.accessToken;
    }
  } catch {
    console.log( "failed to get access token" );
    res.status(401).json({
        'error': 'Could not acquire credentials to access your Azure Key Vault'
        });  
      return; 
  }

  // Load issuance template
  var requestConfigFile = process.env.issuance_requestTemplate;
  var issuanceConfig = require( requestConfigFile );

  // callback
  issuanceConfig.callback.url = process.env.baseURL + '/api/issuer/issuance-request-callback';
  issuanceConfig.callback.state = id;
  // authority
  issuanceConfig.authority = process.env.issuance_authority;
  // registration
  issuanceConfig.registration.clientName = process.env.issuance_registration_clientName;
  issuanceConfig.registration.logoUrl = process.env.issuance_registration_logoUrl;
  issuanceConfig.registration.termsOfServiceUrl = process.env.issuance_registration_termsOfServiceUrl;
  // type
  issuanceConfig.type = process.env.issuance_type;
  // manifest
  issuanceConfig.manifest = process.env.issuance_CredentialManifest;
  // claims
  issuanceConfig.claims.email = req.oidc.user.email;
  issuanceConfig.claims.name = req.oidc.user.name;

  console.log( 'Invoke VC Issuance Request API' );
  console.log( issuanceConfig );

  var payload = JSON.stringify(issuanceConfig);
  const fetchOptions = {
    method: 'POST',
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length.toString(),
      'Authorization': `Bearer ${accessToken}`
    }
  };

  var client_api_request_endpoint = 'https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createIssuanceRequest';
  const response = await fetch(client_api_request_endpoint, fetchOptions);
  var resp = await response.json()
  resp.id = id;
  console.log( 'VC Client API Response' );
  console.log( resp );
  res.status(200).json(resp);       
})

// Issuance request callback
app.post('/api/issuer/issuance-request-callback', async (req, res) => {
  var message = null;
  if ( req.body.requestStatus == "request_retrieved" ) {
    message = "QR Code is scanned. Waiting for issuance to complete...";
  }
  if ( req.body.requestStatus == "issuance_successful" ) {
    message = "Credential successfully issued";
  }
  if ( req.body.requestStatus == "issuance_error" ) {
    message = req.body.error.message;
  }
  if ( message != null ) {
    console.log(message);
    sessionStore.get(req.body.state, (error, session) => {
      var sessionData = {
        "status" : req.body.requestStatus,
        "message": message
      };
      session.sessionData = sessionData;
      sessionStore.set( req.body.state, session, (error) => {
        res.send();
      });
    })
    res.send()
  }
  res.send()
})

// issuance response
app.get('/api/issuer/issuance-response', async (req, res) => {
  var id = req.query.id;
  sessionStore.get( id, (error, session) => {
    if (session && session.sessionData) {
      if(session.sessionData.message == 'Credential successfully issued'){
        // record issuance status to database
        if(process.env.record_issuance_event.toUpperCase() == 'TRUE'){
          const crypto = require("crypto");
          const recordIssuanceEvent = require('./aztbl.js');
          console.log(`issuance completed to ${req.oidc.user.email}`);
          // at this moment, MS Entra does not return credential id on issuance, so use UUID instead.
          recordIssuanceEvent(crypto.randomUUID(), req.oidc.user.email, req.oidc.user.name, process.env.issuance_type);
        }
      }
      res.status(200).json(session.sessionData);   
    }
  })
})

// start server
app.listen(port, () => console.log(`VC Issuer Web App is listening on port ${port}!`))
