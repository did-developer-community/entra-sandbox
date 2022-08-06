// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Verifiable Credentials Issuer Sample

///////////////////////////////////////////////////////////////////////////////////////
// Node packages
var bodyParser = require('body-parser');
var mainApp = require('./app.js');
var parser = bodyParser.urlencoded({ extended: false });
var fetch = require( 'node-fetch' );

function generatePin( digits ) {
  var add = 1, max = 12 - add;
  max        = Math.pow(10, digits+add);
  var min    = max/10; // Math.pow(10, n) basically
  var number = Math.floor( Math.random() * (max - min + 1) ) + min;
  return ("" + number).substring(add); 
}

/**
 * This method is called from the UI to initiate the issuance of the verifiable credential
 */
mainApp.app.get('/api/issuer/issuance-request', async (req, res) => {
  // (re)load issuance template
  var requestConfigFile = process.env.issuance_requestTemplate;
  var issuanceConfig = require( requestConfigFile );
  issuanceConfig.registration.clientName = process.env.issuance_clientName;
  issuanceConfig.authority = process.env.issuance_authority;
  // if there is pin code in the config, but length is zero - remove it. It really shouldn't be there
  if ( issuanceConfig.pin && issuanceConfig.pin.length == 0 ) {
    issuanceConfig.pin = null;
  }

  var id = req.session.id;
  // prep a session state of 0
  mainApp.sessionStore.get( id, (error, session) => {
    var sessionData = {
      "status" : 0,
      "message": "Waiting for QR code to be scanned"
    };
    if ( session ) {
      session.sessionData = sessionData;
      mainApp.sessionStore.set( id, session);  
    }
  });

  // get the Access Token
  var accessToken = "";
  try {
    const result = await mainApp.msalCca.acquireTokenByClientCredential(mainApp.msalClientCredentialRequest);
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

  issuanceConfig.callback.url = process.env.baseURL + '/api/issuer/issuance-request-callback';
  issuanceConfig.callback.state = id;
  if ( issuanceConfig.pin ) {
    issuanceConfig.pin.value = generatePin( issuanceConfig.pin.length );
  }
  issuanceConfig.type = '["TRAINING","CTC"]';
  issuanceConfig.claims.name = req.oidc.user.name;
  issuanceConfig.claims.company = "DID Developer Community";
  issuanceConfig.claims.date = "200220803";

  issuanceConfig.manifest = process.env.issuance_CredentialManifest;

  console.log( 'VC Client API Request' );
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
  // the response from the VC Request API call is returned to the caller (the UI). It contains the URI to the request which Authenticator can download after
  // it has scanned the QR code. If the payload requested the VC Request service to create the QR code that is returned as well
  // the javascript in the UI will use that QR code to display it on the screen to the user.            
  resp.id = id;                              // add session id so browser can pull status
  if ( issuanceConfig.pin ) {
    resp.pin = issuanceConfig.pin.value;   // add pin code so browser can display it
  }
  console.log( 'VC Client API Response' );
  console.log( resp );
  res.status(200).json(resp);       
})
/**
 * This method is called by the VC Request API when the user scans a QR code and presents a Verifiable Credential to the service
 */
mainApp.app.post('/api/issuer/issuance-request-callback', parser, async (req, res) => {
  var body = '';
  req.on('data', function (data) {
    body += data;
  });
  req.on('end', function () {
    var issuanceResponse = JSON.parse(body.toString());
    var message = null;
    // there are 2 different callbacks. 1 if the QR code is scanned (or deeplink has been followed)
    // Scanning the QR code makes Authenticator download the specific request from the server
    // the request will be deleted from the server immediately.
    // That's why it is so important to capture this callback and relay this to the UI so the UI can hide
    // the QR code to prevent the user from scanning it twice (resulting in an error since the request is already deleted)
    if ( issuanceResponse.code == "request_retrieved" ) {
      message = "QR Code is scanned. Waiting for issuance to complete...";
    }
    if ( issuanceResponse.code == "issuance_successful" ) {
      message = "Credential successfully issued";
    }
    if ( issuanceResponse.code == "issuance_error" ) {
      message = issuanceResponse.error.message;
    }
    if ( message != null ) {
      mainApp.sessionStore.get(issuanceResponse.state, (error, session) => {
        var sessionData = {
          "status" : issuanceResponse.code,
          "message": message
        };
        session.sessionData = sessionData;
        mainApp.sessionStore.set( issuanceResponse.state, session, (error) => {
          res.send();
        });
      })
    }
    res.send()
  });  
  res.send()
})
/**
 * this function is called from the UI polling for a response from the AAD VC Service.
 * when a callback is recieved at the presentationCallback service the session will be updated
 * this method will respond with the status so the UI can reflect if the QR code was scanned and with the result of the presentation
 */
mainApp.app.get('/api/issuer/issuance-response', async (req, res) => {
  var id = req.query.id;
  mainApp.sessionStore.get( id, (error, session) => {
    if (session && session.sessionData) {
      res.status(200).json(session.sessionData);   
    }
  })
})

