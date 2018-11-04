const cacheControl = require('express-cache-controller');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const graphLayout = require('./graphLayout.js');

module.exports = function (app, options) {
    var lightning = {};
    if (options.daemon === "clightning") {
        // setup clightning client
        const clightning = require("./lightning/clightning")(options.clightningDir);
        lightning = clightning;
    } else {
        const protoPath = path.join(__dirname, 'lnd.proto');
        const lndCertPath = path.join(options.lndDir, 'tls.cert');
        const macaroonPath = path.join(options.lndDir, 'admin.macaroon');
        const lnd = require("./lightning/lnd")(protoPath, options.lndHost, lndCertPath, macaroonPath);
        lightning = lnd;
    }
    lndAlias = options.lndAlias;
    pruneTTLms = options.pruneTTL * 24 * 60 * 60 * 1000;

    var graphdata = {
        nodes: [],
        edges: []
    };

    var graphpos = [];

    async function CalculateLayout(data)
    {
        console.log("Calculating graph layout...");
	// filter data to prune unresponsive nodes if requested
	const recentData = filterDataToRecent(data, pruneTTLms, lndAlias);

        var result = await graphLayout(recentData);

        // Both have to be in sync
        graphdata = recentData;
        graphpos = result;

        console.log("Updated graph data");
    }

    function UpdateNetworkGraph()
    {
        if (options.dummyDataPath)
        {
            console.log(`Fetching graph data from local file '${options.dummyDataPath}'`);
            fs.readFile(options.dummyDataPath, (err, data) => {
                if (!err)
                {
                    data = JSON.parse(data);
                    console.log(`Successfully fetched ${data.nodes.length} nodes and ${data.edges.length} edges`);
                    CalculateLayout(data);
                }
                else
                    console.log(err);
            });
        }
        else
        {
            console.log("Fetching graph data from lightning daemon...");
            lightning.DescribeGraph({}, (err, resp) => {
                if (!err)
                {
                    console.log(`Successfully fetched ${resp.nodes.length} nodes and ${resp.edges.length} edges`);
                    CalculateLayout(resp);
                }
                else
                    console.log(err);
            });
        }
    }

    // Saves network graph to file
    function SaveGraph()
    {
        var filepath = path.join(options.logDir, 'networkgraph_' + moment().format('YYYY-MM-DD_HH-mm') + '.json');
        fs.writeFile(filepath, JSON.stringify(graphdata), function (err) {
            if (err)
                console.log(err);
            else
                console.log("Saved network graph to " + filepath);
        });
    }


    // Filters nodes and edges to the recently seen set
    function filterDataToRecent(data, ttl, nodeAlias) {
        const recentNodesByKey = data.nodes.reduce((set, node) => {
            if (Date.now() - node.last_update * 1000 <= ttl || node.alias == nodeAlias) {
                set.add(node.pub_key);
            }
            return set;
        }, new Set());

        const recentNodes = data.nodes.filter(n => recentNodesByKey.has(n.pub_key));
        const recentEdges = data.edges.filter(
            ({ node1_pub, node2_pub }) =>
                recentNodesByKey.has(node1_pub) && recentNodesByKey.has(node2_pub)
            );
                
        return { nodes: recentNodes, edges: recentEdges };
    }


    setInterval(SaveGraph, options.graphLogInterval);

    //FORCE SSL
    app.use(function(req, res, next) {
        if (req.headers['x-forwarded-proto'] === 'http') {
            return res.redirect('https://' + req.headers.host + req.url);
        }
        next();
    });

    // CORS endpoint for network graph
    app.get('/networkgraph', function(req, res) {
        // Allow CORS
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

        // Send data
        res.send(graphdata);
    });

    // CORS endpoint for network graph with precalculated positions
    app.get('/networkgraphv2', function(req, res) {
        // Allow CORS
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

        // Send data
        res.send({
            ...graphdata,
            pos: graphpos
        });
    });

    // Create payment invoice
    app.get('/getinvoice', function(req, res) {
        // Disable cache
        res.cacheControl = {
            noCache: true
        };

        var value = parseInt(req.query.value);

        if (!value || isNaN(value) || value < 1)
            return res.status(500).send('Malformed tip value');

        if (value > 4294967)
            return res.status(500).send('Whoah, thanks for generosity but tips under uint32 limit will do! (4,294,967,295 msat to be precise)');

        lightning.AddInvoice({
            memo: "LN Explorer Tips",
            value: value
        }, function(err, resp) {
            if (!err)
                res.send(resp);
            else
            {
                console.log(err);
                res.status(500).send('Error generating invoice');
            }
        });
    });

    function isHexString(str)
    {
        var re = /[0-9A-Fa-f]{6}/g;
        return re.test(str);
    }

    // Reply with invoice status
    app.get('/invoicestatus', function(req, res) {
        // Disable cache
        res.cacheControl = {
            noCache: true
        };

        var rhash = req.query.rhash;

        if (!isHexString(rhash) || rhash.length != 64)
            return res.status(500).send('Malformed rhash');

        lightning.LookupInvoice({
            r_hash_str: rhash
        }, function(err, resp) {
            if (!err)
                res.send(resp.settled);
            else
                res.status(500).send('Error checking invoice status');
        });
    });

    // Update network graph and start update timer
    UpdateNetworkGraph();
    setInterval(UpdateNetworkGraph, options.updateInterval);
};
