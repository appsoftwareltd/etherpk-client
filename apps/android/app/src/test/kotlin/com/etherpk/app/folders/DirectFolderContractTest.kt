package com.etherpk.app.folders

import com.etherpk.app.ContractHarness
import com.etherpk.app.DirectHarness
import com.etherpk.app.PortContract
import java.nio.file.Files

/** The port's contract over folders reached by path, on this computer's disk. */
class DirectFolderContractTest : PortContract() {
    override fun makeHarness(): ContractHarness =
        DirectHarness(Files.createTempDirectory("etherpk-disk").toFile(), Files.createTempDirectory("etherpk-state").toFile())
}
