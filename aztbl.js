'use strict';
require('dotenv').config();
const { TableClient, AzureNamedKeyCredential } = require("@azure/data-tables");
const credential = new AzureNamedKeyCredential(process.env.azTblAccount, process.env.azTblAccountKey);
const client = new TableClient(`https://${process.env.azTblAccount}.table.core.windows.net`, process.env.azTblName, credential);

async function recordIssuanceEvent(key, email, name, credentialType){
  const vcIssuanceEntity = {
    partitionKey: credentialType,
    rowKey: key,
    email: email,
    name: name
  };
  await client.createEntity(vcIssuanceEntity);
}

module.exports = recordIssuanceEvent;
