prettier-no-jsx-parens -w .
pkill -ife example-
PS1='\$\n\$\n\$ '
clear
instructions='please fully rewrite all necessary files to fix issues'
for x in *.ts; do
    echo $'\n\n\n\n'
    echo "START FILE $x"
    cat $x
    echo "END FILE $x"
done

esr example-little-server.ts &

esr example-little-client.ts

pkill -ife example-

esr example-big-server.ts &

esr example-big-client.ts
pkill -ife example-

pnpm exec tsc
